import { toIst } from "@atb/trading-core";
import { app } from "./app";
import type { Env } from "./env";
import { ACCOUNT_IDS } from "./env";
import type { AccountId } from "@atb/shared-types";
import type { RiskManagerDO } from "./do/risk-manager";
import type { TradingAccountDO } from "./do/trading-account";
import { deliver, type NotifyMessage } from "./lib/notify";

export { TradingAccountDO } from "./do/trading-account";
export { RiskManagerDO } from "./do/risk-manager";
export { PositionManagerDO } from "./do/position-manager";
export { OrderManagerDO } from "./do/order-manager";
export { RealtimeSessionDO } from "./do/realtime-session";

/** Cron jobs are at-least-once: guard each (job, runKey) with a unique row in D1. */
async function once(env: Env, job: string, runKey: string, fn: () => Promise<void>): Promise<void> {
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO cron_runs (job, run_key, started_at, status) VALUES (?, ?, ?, 'RUNNING')",
  )
    .bind(job, runKey, Date.now())
    .run();
  if (!claim.meta.changes) return; // already ran (or running)
  try {
    await fn();
    await env.DB.prepare("UPDATE cron_runs SET status='DONE', finished_at=? WHERE job=? AND run_key=?")
      .bind(Date.now(), job, runKey)
      .run();
  } catch (e) {
    await env.DB.prepare("UPDATE cron_runs SET status='FAILED', finished_at=? WHERE job=? AND run_key=?")
      .bind(Date.now(), job, runKey)
      .run();
    throw e;
  }
}

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const ist = toIst(controller.scheduledTime);
    for (const id of ACCOUNT_IDS) {
      const risk = env.RISK_MANAGER.get(env.RISK_MANAGER.idFromName(id));
      const account = env.TRADING_ACCOUNT.get(env.TRADING_ACCOUNT.idFromName(id));
      await runCron(controller.cron, id, ist, env, ctx, risk, account);
    }
  },

  async queue(batch: MessageBatch<Record<string, unknown>>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (batch.queue.endsWith("notifications")) {
          const b = msg.body as Partial<NotifyMessage>;
          await deliver(env, {
            event: String(b.event ?? "EVENT"),
            message: String(b.message ?? ""),
            dedupeKey: String(b.dedupeKey ?? msg.id),
          });
        }
        // trade-events / signal-processing consumers are implemented in later phases.
        msg.ack();
      } catch (e) {
        console.error(JSON.stringify({ level: "error", queue: batch.queue, err: String(e) }));
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, Record<string, unknown>>;

async function runCron(
  cron: string,
  id: AccountId,
  ist: ReturnType<typeof toIst>,
  env: Env,
  ctx: ExecutionContext,
  risk: DurableObjectStub<RiskManagerDO>,
  account: DurableObjectStub<TradingAccountDO>,
): Promise<void> {
  const controller = { cron };
  switch (controller.cron) {
    case "30 0 * * *":
      await once(env, `daily-risk-reset:${id}`, ist.date, async () => {
        await risk.dailyReset(ist.date, ist.weekday === 1);
      });
      break;
    case "45 2 * * 1-5":
      await once(env, `session-prep:${id}`, ist.date, async () => {
        // Phase 4+: refresh instruments/holidays, verify broker session via gateway.
        await env.Q_ANALYTICS.send({ type: "SESSION_PREP", account: id, date: ist.date });
      });
      break;
    case "*/5 3-10 * * 1-5": {
      // Gateway liveness: no fresh lease => block new trades (fail closed).
      const s = await account.getState(id);
      if (!s.lease || s.lease.expiresAt < Date.now() - 60_000) {
        const snap = await risk.getSnapshot();
        if (!snap.state.tradingLocked) {
          await risk.lock("SYSTEM_FAILURE");
          ctx.waitUntil(
            env.Q_NOTIFICATIONS.send({
              event: "BROKER_ERROR",
              message: `[${id.toUpperCase()}] Execution gateway heartbeat lost — new trades locked`,
              dedupeKey: `hb-lost-${id}-${Math.floor(Date.now() / 3_600_000)}`,
            }),
          );
        }
      }
      break;
    }
    case "30 10 * * 1-5":
      await once(env, `daily-report:${id}`, ist.date, async () => {
        await env.Q_ANALYTICS.send({ type: "DAILY_REPORT", account: id, date: ist.date });
      });
      break;
  }
}
