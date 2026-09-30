import {
  CandleAggregator,
  DEFAULT_ENSEMBLE,
  DEFAULT_EXIT_POLICY,
  FEATURES_VERSION,
  FeatureFrame,
  PerformanceMonitor,
  TIMEFRAME_MS,
  checkQuote,
  evaluateEnsemble,
  onBar,
  openTrade,
  type EnsembleConfig,
  type ExitPolicy,
  type ManagedTrade,
  type MarketDataProvider,
} from "@atb/engine";
import type {
  Candle,
  FinalSignal,
  Instrument,
  KillSwitchTrigger,
  ProductType,
  Quote,
  RiskLimits,
  Tick,
  Timeframe,
  TradingMode,
} from "@atb/shared-types";
import {
  DEFAULT_LIMITS,
  DEFAULT_SESSION,
  PaperBroker,
  clientOrderIdFor,
  estimateCosts,
  evaluateTrade,
  protectedLimitPrice,
  sessionPhase,
  toIst,
  type SessionConfig,
} from "@atb/trading-core";
import type { AiClient } from "./ai-client";
import type { ControlPlane, HeartbeatResponse } from "./control-plane";
import type { OrderExecutor } from "./executor";
import type { EventReporter } from "./reporter";
import type { StateStore } from "./state-store";
import { isFill, type StopState, type Venue } from "./venue";

export interface EngineConfig {
  instruments: Instrument[];
  timeframe: Timeframe;
  product: ProductType;
  marginFraction: number;
  ensemble: EnsembleConfig;
  exitPolicy: ExitPolicy;
  session: SessionConfig;
  minRewardRisk: number;
  maxStopDistancePct: number;
  maxDataStalenessMs: number;
  abnormalSlippageBps: number;
  historyDays: number;
  maxBarsKept: number;
  canaryCapitalPct: number;
  aiEnabled: boolean;
  aiMinProbability: number;
  modelVersion: string;
}

export const DEFAULT_ENGINE_CONFIG: Omit<EngineConfig, "instruments"> = {
  timeframe: "5m",
  product: "INTRADAY",
  marginFraction: 0.2,
  ensemble: DEFAULT_ENSEMBLE,
  exitPolicy: DEFAULT_EXIT_POLICY,
  session: DEFAULT_SESSION,
  minRewardRisk: 1.5,
  maxStopDistancePct: 5,
  maxDataStalenessMs: 15_000,
  abnormalSlippageBps: 50,
  historyDays: 10,
  maxBarsKept: 1500,
  canaryCapitalPct: 5,
  aiEnabled: false,
  aiMinProbability: 0.55,
  modelVersion: "rules-ensemble-1.0.0",
};

type Target = "sim" | "paper" | "live";

export interface EngineTrade {
  key: string;
  mode: TradingMode;
  target: Target;
  instrumentId: string;
  trade: ManagedTrade;
  stop: StopState;
  signalId: string;
  strategy: string;
  regime: string;
  quality: number;
  modelVersion: string;
  refEntry: number;
  riskAmount: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  exitNotional: number;
  exitQty: number;
  exitSeq: number;
  lastReason: string;
  product: ProductType;
  closing?: boolean;
}

export interface PersistedState {
  trades: EngineTrade[];
  day: string;
  dailyPnl: number;
  weeklyPnl: number;
  peakEquity: number;
  monitor: { r: number[]; consecutiveLosses: number };
}

export interface EngineDeps {
  executor: OrderExecutor;
  venues: Record<Target, Venue>;
  provider: MarketDataProvider;
  reporter: EventReporter;
  controlPlane: ControlPlane;
  store: StateStore<PersistedState>;
  ai?: AiClient;
  paperBroker?: PaperBroker;
  monitor?: PerformanceMonitor;
  now?: () => number;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Live trading engine (runs on the lease-holding gateway node).
 * Candle close → features → regime → strategies → ensemble → (optional AI meta filter) →
 * deterministic risk gateway → venue (sim / paper / live) → broker-resident stop → trade
 * management → journal. Every uncertainty blocks NEW trades; protective actions keep working.
 */
export class TradingEngine {
  readonly cfg: EngineConfig;
  private readonly now: () => number;
  private readonly log: NonNullable<EngineDeps["log"]>;
  readonly monitor: PerformanceMonitor;
  readonly quotes = new Map<string, Quote>();
  private readonly candles = new Map<string, Candle[]>();
  private readonly aggregators = new Map<string, CandleAggregator>();
  private readonly byId: Map<string, Instrument>;
  readonly open = new Map<string, EngineTrade>(); // instrumentId -> trade
  private readonly entering = new Set<string>();
  private limits: RiskLimits = DEFAULT_LIMITS;
  private equity = 0;
  private peakEquity = 0;
  private day = "";
  private dailyPnl = 0;
  private weeklyPnl = 0;
  private slippageStrikes = 0;
  private mismatchStrikes = 0;
  private brokerErrors = 0;
  private readonly signalTimes: number[] = [];
  lastSignal: FinalSignal | null = null;

  constructor(
    cfg: Partial<EngineConfig> & { instruments: Instrument[] },
    private readonly d: EngineDeps,
  ) {
    this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...cfg };
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => undefined);
    this.monitor = d.monitor ?? new PerformanceMonitor();
    this.byId = new Map(this.cfg.instruments.map((i) => [i.id, i]));
    const tf = TIMEFRAME_MS[this.cfg.timeframe];
    for (const inst of this.cfg.instruments) {
      this.candles.set(inst.id, []);
      this.aggregators.set(
        inst.id,
        new CandleAggregator(
          tf,
          (c) => void this.onCandle(inst.id, c),
          this.cfg.session.alwaysOpen ? null : 9 * 60 + 15,
        ),
      );
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Restore persisted state and load recent history for indicator warm-up. */
  async init(): Promise<void> {
    const s = this.d.store.load();
    if (s) {
      for (const t of s.trades) this.open.set(t.instrumentId, t);
      this.day = s.day;
      this.dailyPnl = s.dailyPnl;
      this.weeklyPnl = s.weeklyPnl;
      this.peakEquity = s.peakEquity;
      this.monitor.restore(s.monitor.r, s.monitor.consecutiveLosses);
      if (s.trades.length) this.log("warn", "restored_open_trades", { count: s.trades.length });
    }
    const from = this.now() - this.cfg.historyDays * 86_400_000;
    for (const inst of this.cfg.instruments) {
      try {
        const hist = await this.d.provider.getOHLCV(inst.id, this.cfg.timeframe, from, this.now());
        this.candles.set(inst.id, hist.slice(-this.cfg.maxBarsKept));
      } catch (e) {
        this.log("warn", "history_unavailable", { instrument: inst.id, err: String(e) });
      }
    }
  }

  applyControl(hb: HeartbeatResponse | null): void {
    if (hb) this.limits = hb.limits;
  }

  private persist(): void {
    this.d.store.save({
      trades: [...this.open.values()],
      day: this.day,
      dailyPnl: this.dailyPnl,
      weeklyPnl: this.weeklyPnl,
      peakEquity: this.peakEquity,
      monitor: this.monitor.history(),
    });
  }

  private get mode(): TradingMode | "UNKNOWN" {
    return this.d.executor.status.mode;
  }

  private targetFor(mode: TradingMode | "UNKNOWN"): Target | null {
    if (mode === "SHADOW") return "sim";
    if (mode === "PAPER") return "paper";
    if (mode === "CANARY" || mode === "LIVE") return "live";
    return null;
  }

  private rollDay(t: number): void {
    const ist = toIst(t);
    if (ist.date !== this.day) {
      if (this.day && ist.weekday === 1) this.weeklyPnl = 0;
      this.day = ist.date;
      this.dailyPnl = 0;
    }
  }

  // ------------------------------------------------------------------ market data

  onTick(t: Tick): void {
    if (!this.byId.has(t.instrumentId) || !(t.ltp > 0)) return;
    this.quotes.set(t.instrumentId, { instrumentId: t.instrumentId, ltp: t.ltp, timestamp: t.timestamp });
    this.aggregators.get(t.instrumentId)!.onTick(t, true);
    // Paper broker resting orders (entries/stops) evaluate on every tick like an exchange would.
    this.d.paperBroker?.processPendingOrders((id) => this.byId.get(id));
    // SHADOW trades: tick-level stop check (hypothetical broker stop).
    const et = this.open.get(t.instrumentId);
    if (et && et.target === "sim" && !et.closing) {
      const long = et.trade.side === "BUY";
      if (long ? t.ltp <= et.trade.stop : t.ltp >= et.trade.stop) {
        const qty = et.trade.qty;
        et.trade.qty = 0;
        void this.recordExit(et, "STOP", qty, et.trade.stop).then(() => this.finalizeIfClosed(et));
      }
    }
  }

  /** Timer: close bars whose window ended even if no tick arrived. */
  flush(now = this.now()): void {
    for (const a of this.aggregators.values()) a.flush(now);
  }

  /** Candle close handler (public for replay/testing). */
  async onCandle(instrumentId: string, candle: Candle): Promise<void> {
    const inst = this.byId.get(instrumentId);
    if (!inst) return;
    const arr = this.candles.get(instrumentId)!;
    const last = arr.at(-1);
    if (last && candle.t <= last.t) return; // duplicate / out-of-order bar
    arr.push(candle);
    if (arr.length > this.cfg.maxBarsKept) arr.splice(0, arr.length - this.cfg.maxBarsKept);
    const closeTime = candle.t + TIMEFRAME_MS[this.cfg.timeframe];
    const q = this.quotes.get(instrumentId);
    if (!q || q.timestamp < closeTime - 1)
      this.quotes.set(instrumentId, {
        instrumentId,
        ltp: candle.c,
        timestamp: Math.min(closeTime, this.now()),
      });
    this.rollDay(closeTime - 1);

    const f = new FeatureFrame(arr);
    const i = f.n - 1;
    const phase = sessionPhase(closeTime - 1, this.cfg.session);

    const et = this.open.get(instrumentId);
    if (et) await this.manage(et, inst, candle, f.atr14[i]!, phase === "SQUARE_OFF" || phase === "CLOSED");
    if (!this.open.has(instrumentId) && !this.entering.has(instrumentId) && phase === "OPEN") {
      await this.considerEntry(inst, f, i, closeTime);
    }
    this.persist();
  }

  // ------------------------------------------------------------------ entries

  private entryBlockers(): string[] {
    const mode = this.mode;
    if (mode === "SHADOW") {
      return this.d.executor.blockReasons().filter((r) => /heartbeat|kill switch|mode/.test(r));
    }
    return this.d.executor.blockReasons();
  }

  private async considerEntry(
    inst: Instrument,
    f: FeatureFrame,
    i: number,
    closeTime: number,
  ): Promise<void> {
    const target = this.targetFor(this.mode);
    if (!target) return;
    const quote = this.quotes.get(inst.id);
    const health = checkQuote(quote, this.now(), Math.max(this.cfg.maxDataStalenessMs, 1000));

    const { signal } = evaluateEnsemble(
      f,
      i,
      { instrumentId: inst.id, modelVersion: this.cfg.modelVersion, now: closeTime },
      this.cfg.ensemble,
    );
    if (signal.decision !== "BUY" && signal.decision !== "SELL") return;
    this.lastSignal = signal;

    // Model anomaly guard: an exploding signal rate means something is wrong.
    this.signalTimes.push(this.now());
    while (this.signalTimes.length && this.now() - this.signalTimes[0]! > 3_600_000) this.signalTimes.shift();
    if (this.signalTimes.length > 20 * this.cfg.instruments.length) {
      await this.trip("MODEL_ANOMALY", `signal rate ${this.signalTimes.length}/h`);
      return;
    }

    const report = (extra: Record<string, unknown>) =>
      this.d.reporter.push(
        "SIGNAL",
        this.mode as TradingMode,
        { ...signal, ...extra, featuresVersion: FEATURES_VERSION },
        `sig-${signal.id}-${this.mode}`,
      );

    const blockers = this.entryBlockers();
    if (blockers.length)
      return report({ riskDecision: "REJECTED", riskFailedCheck: "GATEWAY", reasonsBlocked: blockers });
    if (!health.fresh)
      return report({ riskDecision: "REJECTED", riskFailedCheck: "DATA_FRESHNESS", note: health.reason });
    if (this.monitor.riskMultiplier === 0)
      return report({
        riskDecision: "REJECTED",
        riskFailedCheck: "PERFORMANCE_MONITOR",
        monitor: this.monitor.snapshot(),
      });

    // Optional AI meta-label filter — fails closed.
    let quality = signal.quality;
    if (this.cfg.aiEnabled) {
      const strategies = (signal.reasons.strategyAgreement ?? "")
        .split(" → ")[0]!
        .split(", ")
        .filter(Boolean);
      const r = this.d.ai
        ? await this.d.ai.meta({
            instrument_id: inst.id,
            side: signal.decision,
            strategies,
            regime: signal.regime,
            features: sanitize(f.vector(i)),
            mode: this.mode as "PAPER" | "SHADOW" | "CANARY" | "LIVE",
          })
        : null;
      if (!r || r.probability === null)
        return report({ riskDecision: "REJECTED", riskFailedCheck: "AI_UNAVAILABLE" });
      if (r.probability < this.cfg.aiMinProbability)
        return report({
          riskDecision: "REJECTED",
          riskFailedCheck: "AI_FILTER",
          aiProbability: r.probability,
        });
      quality = Math.min(1, 0.5 * quality + 0.5 * r.probability);
    }

    const sizingEquity =
      this.mode === "CANARY" ? (this.equity * this.cfg.canaryCapitalPct) / 100 : this.equity;
    let gross = 0;
    for (const t of this.open.values())
      gross += (this.quotes.get(t.instrumentId)?.ltp ?? t.trade.entry) * t.trade.qty;
    const limits = {
      ...this.limits,
      maxRiskPerTradePct: this.limits.maxRiskPerTradePct * this.monitor.riskMultiplier,
    };
    const risk = evaluateTrade(
      {
        instrument: inst,
        decision: signal.decision,
        entry: quote!.ltp,
        stop: signal.stop,
        targets: signal.targets,
      },
      {
        mode: this.mode as TradingMode,
        killSwitchActive: this.d.executor.status.killSwitchActive,
        sessionAllowsEntry: true,
        now: this.now(),
        lastMarketDataAt: quote!.timestamp,
        maxDataStalenessMs: Math.max(this.cfg.maxDataStalenessMs, 1000),
        limits,
        state: {
          equity: sizingEquity,
          peakEquity: this.mode === "CANARY" ? sizingEquity : Math.max(this.peakEquity, this.equity),
          dailyRealisedPnl: this.dailyPnl,
          weeklyRealisedPnl: this.weeklyPnl,
          openRisk: 0,
          openPositions: this.open.size,
          tradingLocked: false,
          updatedAt: this.now(),
        },
        availableMargin: Math.max(0, sizingEquity - gross * this.cfg.marginFraction),
        marginPerUnit: quote!.ltp * this.cfg.marginFraction,
        symbolExposure: 0,
        correlatedExposure: gross,
        grossExposure: gross,
        minRewardRisk: this.cfg.minRewardRisk,
        maxStopDistancePct: this.cfg.maxStopDistancePct,
        product: this.cfg.product,
      },
    );
    report({
      riskDecision: risk.approved ? "APPROVED" : "REJECTED",
      riskFailedCheck: risk.failedCheck,
      riskReasons: risk.reasons,
      quantity: risk.quantity,
      quality,
    });
    if (!risk.approved) return;

    this.entering.add(inst.id);
    try {
      await this.enter(inst, signal, risk.quantity, quality, target);
    } finally {
      this.entering.delete(inst.id);
    }
  }

  private async enter(
    inst: Instrument,
    signal: FinalSignal,
    qty: number,
    quality: number,
    target: Target,
  ): Promise<void> {
    const mode = this.mode as TradingMode;
    const venue = this.d.venues[target];
    const ref = this.quotes.get(inst.id)!.ltp;
    const side = signal.decision as "BUY" | "SELL";
    const key = `${signal.id.replace(/[^A-Za-z0-9]/g, "").slice(-24)}${mode[0]}`;
    const clientOrderId = clientOrderIdFor(key, "ENTRY");
    const price = protectedLimitPrice(ref, side, inst.instrumentType, inst.tickSize);
    const r = await venue.enter(
      {
        clientOrderId,
        instrument: inst,
        side,
        quantity: qty,
        orderType: "LIMIT",
        product: this.cfg.product,
        price,
      },
      ref,
    );
    this.d.reporter.push(
      "ORDER",
      mode,
      {
        clientOrderId,
        leg: "ENTRY",
        side,
        qty,
        price,
        ref,
        instrumentId: inst.id,
        signalId: signal.id,
        result: r,
      },
      `ord-${clientOrderId}`,
    );
    if (!isFill(r) || r.filledQty <= 0 || !Number.isFinite(r.avgPrice)) {
      if (!isFill(r)) this.brokerErrors++;
      return;
    }
    this.brokerErrors = 0;

    const slipBps = (Math.abs(r.avgPrice - ref) / ref) * 10_000;
    if (slipBps > this.cfg.abnormalSlippageBps && ++this.slippageStrikes >= 2) {
      await this.trip("ABNORMAL_SLIPPAGE", `entry slippage ${slipBps.toFixed(0)}bps`);
    }

    const long = side === "BUY";
    const et: EngineTrade = {
      key,
      mode,
      target,
      instrumentId: inst.id,
      trade: openTrade({
        id: key,
        instrumentId: inst.id,
        side,
        lotSize: inst.lotSize,
        qty: r.filledQty,
        entry: r.avgPrice,
        // If the fill landed beyond the planned stop, the stop becomes an immediate exit.
        stop: long
          ? Math.min(signal.stop, r.avgPrice - inst.tickSize)
          : Math.max(signal.stop, r.avgPrice + inst.tickSize),
        targets: signal.targets,
        openedAt: this.now(),
        intraday: this.cfg.product === "INTRADAY",
      }),
      stop: {},
      signalId: signal.id,
      strategy: (signal.reasons.strategyAgreement ?? "").split(" → ")[0] ?? "",
      regime: signal.regime,
      quality,
      modelVersion: signal.modelVersion,
      refEntry: ref,
      riskAmount: Math.abs(r.avgPrice - signal.stop) * r.filledQty,
      grossPnl: 0,
      fees: estimateCosts({
        side,
        quantity: r.filledQty,
        price: r.avgPrice,
        instrumentType: inst.instrumentType,
        product: this.cfg.product,
      }).total,
      slippage: Math.abs(r.avgPrice - ref) * r.filledQty,
      exitNotional: 0,
      exitQty: 0,
      exitSeq: 0,
      lastReason: "",
      product: this.cfg.product,
    };
    this.open.set(inst.id, et);
    this.dailyPnl -= et.fees;
    this.weeklyPnl -= et.fees;
    this.persist();

    // Broker-resident protective stop IMMEDIATELY. If it can't be placed, flatten now.
    const sr = await venue.placeStop(key, inst, side, et.trade.qty, et.trade.stop, et.stop, et.product);
    if (!("ok" in sr)) {
      this.log("error", "stop_placement_failed", { key, err: "error" in sr ? sr.error : "unknown" });
      this.d.reporter.push("RISK_EVENT", mode, {
        type: "STOP_PLACEMENT_FAILED",
        severity: "CRITICAL",
        key,
        detail: sr,
      });
      await this.exitNow(et, inst, "MANUAL");
      return;
    }
    this.d.reporter.push(
      "TRADE_OPENED",
      mode,
      {
        key,
        instrumentId: inst.id,
        side,
        qty: et.trade.qty,
        entry: et.trade.entry,
        stop: et.trade.stop,
        targets: et.trade.targets,
        strategy: et.strategy,
        regime: et.regime,
        quality,
        signalId: signal.id,
        modelVersion: et.modelVersion,
      },
      `open-${key}`,
    );
    this.persist();
  }

  // ------------------------------------------------------------------ management

  private async manage(
    et: EngineTrade,
    inst: Instrument,
    c: Candle,
    atr: number,
    squareOff: boolean,
  ): Promise<void> {
    if (et.closing) return;
    const venue = this.d.venues[et.target];
    // 1) Broker stop already filled?
    const sf = await venue.stopFilled(et.stop);
    if (sf) {
      const qty = Math.min(sf.filledQty, et.trade.qty);
      et.trade.qty -= qty;
      await this.recordExit(et, "STOP", qty, sf.avgPrice);
      et.stop = {};
      await this.finalizeIfClosed(et);
      return;
    }

    const stopBefore = et.trade.stop;
    const fills = onBar(
      et.trade,
      { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, atr, squareOff },
      this.cfg.exitPolicy,
    );
    for (const x of fills) {
      const isStop = x.reason.endsWith("STOP");
      if (et.target === "sim") {
        await this.recordExit(et, x.reason, x.qty, x.price);
        continue;
      }
      // Real venue: stop-type exits mean the broker stop did not fill (e.g. gap) → emergency exit.
      if (isStop || et.trade.qty === 0) await venue.cancelStop(et.stop);
      const ref = this.quotes.get(inst.id)?.ltp ?? x.price;
      const r = await venue.exit(
        clientOrderIdFor(`${et.key}${++et.exitSeq}`, "EXIT"),
        inst,
        et.trade.side,
        x.qty,
        ref,
        et.product,
      );
      if (isFill(r) && r.filledQty > 0) {
        if (r.filledQty < x.qty) et.trade.qty += x.qty - r.filledQty; // remainder still open
        await this.recordExit(et, x.reason, r.filledQty, r.avgPrice);
      } else {
        // Exit failed: restore quantity, keep broker stop, alert. Next bar retries.
        et.trade.qty += x.qty;
        this.brokerErrors++;
        this.d.reporter.push("RISK_EVENT", et.mode, {
          type: "EXIT_FAILED",
          severity: "CRITICAL",
          key: et.key,
          reason: x.reason,
          detail: r,
        });
      }
      if (isStop || et.trade.qty === 0) et.stop = {};
    }

    if (et.trade.qty > 0) {
      if (!et.stop.stopBrokerOrderId && et.target !== "sim") {
        await venue.placeStop(
          `${et.key}${++et.exitSeq}`,
          inst,
          et.trade.side,
          et.trade.qty,
          et.trade.stop,
          et.stop,
          et.product,
        );
      } else if (et.trade.stop !== stopBefore || fills.length) {
        await venue.updateStop(inst, et.trade.side, et.trade.qty, et.trade.stop, et.stop);
      }
    }
    await this.finalizeIfClosed(et);
  }

  private async exitNow(et: EngineTrade, inst: Instrument, reason: "MANUAL" | "EOD"): Promise<void> {
    const venue = this.d.venues[et.target];
    await venue.cancelStop(et.stop);
    const ref = this.quotes.get(inst.id)?.ltp ?? et.trade.entry;
    const qty = et.trade.qty;
    const r = await venue.exit(
      clientOrderIdFor(`${et.key}${++et.exitSeq}`, "EXIT"),
      inst,
      et.trade.side,
      qty,
      ref,
      et.product,
    );
    if (isFill(r) && r.filledQty > 0) {
      et.trade.qty -= r.filledQty;
      await this.recordExit(et, reason, r.filledQty, r.avgPrice);
    }
    await this.finalizeIfClosed(et);
  }

  private async recordExit(et: EngineTrade, reason: string, qty: number, price: number): Promise<void> {
    const inst = this.byId.get(et.instrumentId)!;
    const long = et.trade.side === "BUY";
    const pnl = (long ? 1 : -1) * (price - et.trade.entry) * qty;
    const fee = estimateCosts({
      side: long ? "SELL" : "BUY",
      quantity: qty,
      price,
      instrumentType: inst.instrumentType,
      product: et.product,
    }).total;
    et.grossPnl += pnl;
    et.fees += fee;
    et.exitNotional += price * qty;
    et.exitQty += qty;
    et.lastReason = reason;
    this.dailyPnl += pnl - fee;
    this.weeklyPnl += pnl - fee;
  }

  private async finalizeIfClosed(et: EngineTrade): Promise<void> {
    if (et.trade.qty > 0 || et.closing) return;
    et.closing = true;
    const net = et.grossPnl - et.fees;
    const r = et.riskAmount > 0 ? net / et.riskAmount : 0;
    this.monitor.record(r);
    this.open.delete(et.instrumentId);
    const t = et.trade;
    this.d.reporter.push(
      "TRADE_CLOSED",
      et.mode,
      {
        key: et.key,
        instrumentId: et.instrumentId,
        strategy: et.strategy,
        regime: et.regime,
        side: t.side,
        qty: t.initialQty,
        entry: t.entry,
        exit: et.exitQty ? et.exitNotional / et.exitQty : t.entry,
        stop: t.initialStop,
        targets: t.targets,
        riskAmount: et.riskAmount,
        quality: et.quality,
        fees: et.fees,
        slippage: et.slippage,
        grossPnl: et.grossPnl,
        pnl: net,
        rMultiple: r,
        mfe: t.mfe * t.initialQty,
        mae: t.mae * t.initialQty,
        holdingTimeMs: this.now() - t.openedAt,
        openedAt: t.openedAt,
        closedAt: this.now(),
        modelVersion: et.modelVersion,
        signalId: et.signalId,
        exitReason: et.lastReason,
        monitor: this.monitor.snapshot(),
      },
      `close-${et.key}`,
    );
    if (this.monitor.state === "DISABLED") {
      this.d.reporter.push("RISK_EVENT", et.mode, {
        type: "MODEL_ALERT",
        severity: "WARNING",
        detail: this.monitor.snapshot(),
      });
    }
    this.persist();
  }

  // ------------------------------------------------------------------ safety loops

  private async trip(trigger: KillSwitchTrigger, reason: string): Promise<void> {
    this.log("error", "kill_switch_request", { trigger, reason });
    this.d.reporter.push("RISK_EVENT", (this.mode === "UNKNOWN" ? "SAFE_MODE" : this.mode) as TradingMode, {
      type: "KILL_SWITCH",
      trigger,
      reason,
      severity: "CRITICAL",
    });
    try {
      await this.d.controlPlane.killSwitch?.(trigger, reason);
    } catch {
      // Control plane unreachable: heartbeat goes stale → executor blocks new orders anyway.
    }
  }

  /** Periodic: data freshness, broker error streaks, SAFE_MODE square-off of intraday. */
  async healthCheck(): Promise<void> {
    const now = this.now();
    const phase = sessionPhase(now, this.cfg.session);
    if (phase === "OPEN" || phase === "NO_NEW_ENTRIES") {
      const stale = this.cfg.instruments.filter((i) => !checkQuote(this.quotes.get(i.id), now, 60_000).fresh);
      if (stale.length === this.cfg.instruments.length && this.cfg.instruments.length > 0) {
        await this.trip("MARKET_DATA_FAILURE", "no fresh quotes for 60s on any instrument");
      }
    }
    if (this.brokerErrors >= 3) {
      this.brokerErrors = 0;
      await this.trip("BROKER_FAILURE", "3 consecutive broker errors");
    }
    // Intraday positions are flattened in the square-off window even if no bar closes.
    if (phase === "SQUARE_OFF" && this.cfg.product === "INTRADAY" && !this.cfg.session.alwaysOpen) {
      for (const et of [...this.open.values()])
        if (!et.closing) await this.exitNow(et, this.byId.get(et.instrumentId)!, "EOD");
    }
  }

  /** Periodic: compare broker positions with engine state; publish the risk snapshot. */
  async reconcile(): Promise<{ mismatch: string[] }> {
    const mode = this.mode;
    const target = this.targetFor(mode);
    const broker = target === "live" ? this.d.executor.brokerFor("live") : this.d.executor.brokerFor("paper");
    const mismatch: string[] = [];
    try {
      const bal = await broker.getBalance();
      this.equity = bal.totalEquity;
      this.peakEquity = Math.max(this.peakEquity, this.equity);
      if (target && target !== "sim") {
        const positions = await broker.getPositions();
        const expected = new Map<string, number>();
        for (const et of this.open.values()) {
          if (et.target !== target) continue;
          expected.set(
            et.instrumentId,
            (expected.get(et.instrumentId) ?? 0) + (et.trade.side === "BUY" ? 1 : -1) * et.trade.qty,
          );
        }
        const actual = new Map(positions.map((p) => [p.instrumentId, p.quantity]));
        for (const id of new Set([...expected.keys(), ...actual.keys()])) {
          if (!this.byId.has(id) && !expected.has(id)) continue; // positions we don't manage
          if ((expected.get(id) ?? 0) !== (actual.get(id) ?? 0))
            mismatch.push(`${id}: engine ${expected.get(id) ?? 0} vs broker ${actual.get(id) ?? 0}`);
        }
      }
      if (mismatch.length) {
        if (++this.mismatchStrikes >= 2) await this.trip("POSITION_MISMATCH", mismatch.join("; "));
      } else this.mismatchStrikes = 0;

      let openRisk = 0;
      for (const et of this.open.values())
        openRisk += Math.abs(et.trade.entry - et.trade.stop) * et.trade.qty;
      await this.d.controlPlane.reconciliation?.({
        equity: this.equity,
        dailyRealisedPnl: this.dailyPnl,
        weeklyRealisedPnl: this.weeklyPnl,
        openRisk,
        openPositions: this.open.size,
      });
      this.d.reporter.push(
        "POSITIONS",
        (mode === "UNKNOWN" ? "SAFE_MODE" : mode) as TradingMode,
        {
          positions: [...this.open.values()].map((et) => ({
            instrumentId: et.instrumentId,
            quantity: (et.trade.side === "BUY" ? 1 : -1) * et.trade.qty,
            averagePrice: et.trade.entry,
            lastPrice: this.quotes.get(et.instrumentId)?.ltp,
            stopPrice: et.trade.stop,
            targets: et.trade.targets,
            unrealisedPnl:
              (et.trade.side === "BUY" ? 1 : -1) *
              ((this.quotes.get(et.instrumentId)?.ltp ?? et.trade.entry) - et.trade.entry) *
              et.trade.qty,
            mode: et.mode,
          })),
          equity: this.equity,
          dailyPnl: this.dailyPnl,
          monitor: this.monitor.snapshot(),
        },
        `pos-${Math.floor(this.now() / 30_000)}`,
      );
      this.brokerErrors = 0;
    } catch (e) {
      this.brokerErrors++;
      this.log("warn", "reconcile_failed", { err: String(e) });
    }
    return { mismatch };
  }

  /** Consume the market-data stream until aborted. */
  async run(signal: AbortSignal): Promise<void> {
    for await (const tick of this.d.provider.subscribe(
      this.cfg.instruments.map((i) => i.id),
      signal,
    )) {
      if (signal.aborted) break;
      this.onTick(tick);
    }
  }

  status() {
    return {
      mode: this.mode,
      openTrades: [...this.open.values()].map((t) => ({
        key: t.key,
        instrumentId: t.instrumentId,
        side: t.trade.side,
        qty: t.trade.qty,
        entry: t.trade.entry,
        stop: t.trade.stop,
        target: t.target,
      })),
      equity: this.equity,
      dailyPnl: this.dailyPnl,
      monitor: this.monitor.snapshot(),
      lastSignal: this.lastSignal,
      reporterPending: this.d.reporter.pending,
    };
  }
}

function sanitize(v: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) out[k] = Number.isFinite(x) ? x : 0;
  return out;
}
