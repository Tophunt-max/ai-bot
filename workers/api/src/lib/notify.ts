import type { Env } from "../env";

export interface NotifyMessage {
  event: string;
  message: string;
  dedupeKey: string;
}

/** Enqueue a notification (never blocks the request on Telegram/Expo). */
export async function notify(env: Env, n: NotifyMessage): Promise<void> {
  try {
    await env.Q_NOTIFICATIONS?.send(n);
  } catch (e) {
    console.error(
      JSON.stringify({ level: "error", msg: "notify_enqueue_failed", event: n.event, err: String(e) }),
    );
  }
}

/** Queue consumer side: dedupe via notifications.dedupe_key, then Telegram + Expo push. */
export async function deliver(env: Env, n: NotifyMessage): Promise<void> {
  const now = Date.now();
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO notifications (id, user_id, event, channel, payload, status, dedupe_key, created_at)
     VALUES (?, 'owner', ?, 'TELEGRAM', ?, 'PENDING', ?, ?)`,
  )
    .bind(`ntf_${crypto.randomUUID().replace(/-/g, "")}`, n.event, JSON.stringify(n), n.dedupeKey, now)
    .run();
  if (!claim.meta.changes) return; // already delivered (at-least-once queue)

  const text = `[ATB] ${n.event}\n${n.message}`;
  const jobs: Promise<unknown>[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      }).then((r) => {
        if (!r.ok) throw new Error(`telegram HTTP ${r.status}`);
      }),
    );
  }
  const tokens = await env.DB.prepare("SELECT token FROM push_tokens WHERE user_id = 'owner'").all<{
    token: string;
  }>();
  if (tokens.results.length) {
    jobs.push(
      fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(
          tokens.results.map((t) => ({
            to: t.token,
            title: n.event.replace(/_/g, " "),
            body: n.message,
            priority: "high",
          })),
        ),
      }).then((r) => {
        if (!r.ok) throw new Error(`expo push HTTP ${r.status}`);
      }),
    );
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.some((r) => r.status === "rejected");
  await env.DB.prepare("UPDATE notifications SET status = ?, sent_at = ? WHERE dedupe_key = ?")
    .bind(failed ? "FAILED" : "SENT", Date.now(), n.dedupeKey)
    .run();
}
