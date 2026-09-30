import type { Env } from "../env";
import { OWNER_ACCOUNT } from "../env";

export interface IngestEvent {
  id: string;
  type: "SIGNAL" | "ORDER" | "TRADE_OPENED" | "TRADE_CLOSED" | "RISK_EVENT" | "POSITIONS";
  at: number;
  mode: string;
  payload: Record<string, unknown>;
}

export interface Notification {
  event: string;
  message: string;
  dedupeKey: string;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const json = (v: unknown) => JSON.stringify(v ?? null);

function instrumentUpsert(env: Env, instrumentId: string, now: number) {
  const [exchange = "NSE", symbol = instrumentId] = instrumentId.split(":");
  const ex = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(exchange) ? exchange : "NSE";
  const type = ex === "NFO" || ex === "BFO" ? (/(CE|PE)$/.test(symbol) ? symbol.slice(-2) : "FUT") : "EQ";
  return env.DB.prepare(
    `INSERT OR IGNORE INTO instruments (id, exchange, trading_symbol, instrument_type, lot_size, tick_size, updated_at)
     VALUES (?, ?, ?, ?, 1, 0.05, ?)`,
  ).bind(instrumentId, ex, symbol, type, now);
}

/** Signal row id: must match what TRADE/ORDER events reference (gateway uses `sig-<signalId>-<mode>`). */
export const signalRowId = (signalId: string, mode: string) => `sig-${signalId}-${mode}`;

/**
 * Idempotent ingestion of gateway events into D1 (journal) + notification fan-out.
 * Each event is claimed in `ingested_events` first; duplicates are skipped.
 */
export async function ingestEvents(
  env: Env,
  nodeId: string,
  events: IngestEvent[],
): Promise<{
  inserted: number;
  duplicates: number;
  notifications: Notification[];
  latestPositions?: IngestEvent;
}> {
  const now = Date.now();
  let inserted = 0;
  let duplicates = 0;
  const notifications: Notification[] = [];
  let latestPositions: IngestEvent | undefined;

  for (const e of events) {
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO ingested_events (id, node_id, type, at, received_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(e.id, nodeId, e.type, e.at, now)
      .run();
    if (!claim.meta.changes) {
      duplicates++;
      continue;
    }
    inserted++;
    const p = e.payload;
    const stmts: D1PreparedStatement[] = [];

    switch (e.type) {
      case "SIGNAL": {
        const instrumentId = str(p.instrumentId);
        stmts.push(instrumentUpsert(env, instrumentId, now));
        const targets = Array.isArray(p.targets) ? p.targets : [];
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO signals (id, account_id, instrument_id, decision, regime, quality, entry, stop, targets,
               strategies_agreeing, strategies_total, reasons, risk_decision, risk_failed_check, mode, model_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            e.id,
            OWNER_ACCOUNT,
            instrumentId,
            str(p.decision, "NO_TRADE"),
            str(p.regime, "UNKNOWN"),
            Math.max(0, Math.min(1, num(p.quality))),
            Number.isFinite(p.entry as number) ? (p.entry as number) : null,
            Number.isFinite(p.stop as number) ? (p.stop as number) : null,
            json(targets),
            num(p.strategiesAgreeing),
            num(p.strategiesTotal),
            json({ ...(p.reasons as object), blocked: p.reasonsBlocked, riskReasons: p.riskReasons }),
            p.riskDecision === "APPROVED" ? "APPROVED" : "REJECTED",
            (p.riskFailedCheck as string) ?? null,
            e.mode,
            str(p.modelVersion),
            e.at,
          ),
        );
        if (p.riskDecision === "APPROVED") {
          notifications.push({
            event: "NEW_SIGNAL",
            message: `${e.mode} ${p.decision} ${instrumentId} @ ${num(p.entry).toFixed(2)} SL ${num(p.stop).toFixed(2)} (quality ${num(p.quality).toFixed(2)})`,
            dedupeKey: e.id,
          });
        }
        break;
      }
      case "ORDER": {
        const instrumentId = str(p.instrumentId);
        const result = (p.result ?? {}) as { filledQty?: number; avgPrice?: number; error?: string };
        const status = result.error
          ? "REJECTED"
          : num(result.filledQty) >= num(p.qty)
            ? "FILLED"
            : num(result.filledQty) > 0
              ? "PARTIALLY_FILLED"
              : "CANCELLED";
        stmts.push(instrumentUpsert(env, instrumentId, now));
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO orders (id, client_order_id, account_id, signal_id, instrument_id, leg, side, order_type, product,
               quantity, filled_quantity, price, average_price, status, mode, gateway_node, status_message, created_at, updated_at)
             VALUES (?, ?, ?, (SELECT id FROM signals WHERE id = ?), ?, ?, ?, 'LIMIT', 'INTRADAY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            e.id,
            str(p.clientOrderId, e.id),
            OWNER_ACCOUNT,
            signalRowId(str(p.signalId), e.mode),
            instrumentId,
            str(p.leg, "ENTRY"),
            str(p.side, "BUY"),
            Math.max(1, num(p.qty, 1)),
            num(result.filledQty),
            num(p.price),
            result.avgPrice ?? null,
            status,
            e.mode,
            nodeId,
            result.error ?? null,
            e.at,
            e.at,
          ),
        );
        if (result.error)
          notifications.push({
            event: "BROKER_ERROR",
            message: `Order ${p.clientOrderId} failed: ${result.error}`,
            dedupeKey: e.id,
          });
        break;
      }
      case "TRADE_OPENED": {
        const instrumentId = str(p.instrumentId);
        const qty = num(p.qty);
        stmts.push(instrumentUpsert(env, instrumentId, now));
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO positions (id, account_id, instrument_id, product, quantity, average_price, stop_price, targets,
               realised_pnl, status, mode, opened_at, updated_at)
             VALUES (?, ?, ?, 'INTRADAY', ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
          ).bind(
            str(p.key, e.id),
            OWNER_ACCOUNT,
            instrumentId,
            p.side === "SELL" ? -qty : qty,
            num(p.entry),
            num(p.stop),
            json(p.targets),
            e.mode,
            e.at,
            e.at,
          ),
        );
        notifications.push({
          event: "TRADE_OPENED",
          message: `${e.mode} opened ${p.side} ${qty} ${instrumentId} @ ${num(p.entry).toFixed(2)} SL ${num(p.stop).toFixed(2)} [${p.strategy}]`,
          dedupeKey: e.id,
        });
        break;
      }
      case "TRADE_CLOSED": {
        const instrumentId = str(p.instrumentId);
        stmts.push(instrumentUpsert(env, instrumentId, now));
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO trades (id, account_id, position_id, signal_id, instrument_id, strategy, regime, side, quantity,
               entry_price, exit_price, stop_price, targets, risk_amount, signal_quality, fees, slippage, pnl, gross_pnl, r_multiple,
               mfe, mae, holding_time_ms, model_version, exit_reason, mode, opened_at, closed_at)
             VALUES (?, ?, (SELECT id FROM positions WHERE id = ?), (SELECT id FROM signals WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            str(p.key, e.id),
            OWNER_ACCOUNT,
            str(p.key),
            signalRowId(str(p.signalId), e.mode),
            instrumentId,
            str(p.strategy),
            str(p.regime),
            str(p.side, "BUY"),
            num(p.qty),
            num(p.entry),
            num(p.exit),
            num(p.stop),
            json(p.targets),
            num(p.riskAmount),
            num(p.quality),
            num(p.fees),
            num(p.slippage),
            num(p.pnl),
            num(p.grossPnl),
            num(p.rMultiple),
            num(p.mfe),
            num(p.mae),
            num(p.holdingTimeMs),
            str(p.modelVersion),
            str(p.exitReason),
            e.mode,
            num(p.openedAt, e.at),
            num(p.closedAt, e.at),
          ),
        );
        stmts.push(
          env.DB.prepare(
            "UPDATE positions SET status='CLOSED', quantity=0, realised_pnl=?, closed_at=?, updated_at=? WHERE id=?",
          ).bind(num(p.pnl), e.at, e.at, str(p.key)),
        );
        const reason = str(p.exitReason);
        const ev = reason.includes("STOP") ? "SL_HIT" : reason.startsWith("TP") ? "TP_HIT" : "TRADE_CLOSED";
        notifications.push({
          event: ev,
          message: `${e.mode} closed ${instrumentId} (${reason}) net ₹${num(p.pnl).toFixed(0)} = ${num(p.rMultiple).toFixed(2)}R`,
          dedupeKey: e.id,
        });
        break;
      }
      case "RISK_EVENT": {
        const sev = ["INFO", "WARNING", "CRITICAL"].includes(str(p.severity)) ? str(p.severity) : "WARNING";
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO risk_events (id, account_id, type, trigger, severity, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            e.id,
            OWNER_ACCOUNT,
            str(p.type, "EVENT"),
            (p.trigger as string) ?? null,
            sev,
            json(p),
            e.at,
          ),
        );
        const type = str(p.type);
        const event =
          type === "KILL_SWITCH" ? "KILL_SWITCH" : type === "MODEL_ALERT" ? "MODEL_ALERT" : "BROKER_ERROR";
        if (sev !== "INFO")
          notifications.push({
            event,
            message: `${type}: ${str(p.reason) || json(p.detail ?? p)}`.slice(0, 500),
            dedupeKey: e.id,
          });
        break;
      }
      case "POSITIONS":
        if (!latestPositions || e.at >= latestPositions.at) latestPositions = e;
        break;
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  return { inserted, duplicates, notifications, latestPositions };
}
