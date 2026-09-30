import type { Env } from "../env";
import { newId } from "./crypto";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  ip?: string;
}

/** Append-only audit trail (D1 triggers block UPDATE/DELETE). */
export async function audit(env: Env, e: AuditEntry): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, actor, action, target, before, after, request_id, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId("aud"),
        e.actor,
        e.action,
        e.target ?? null,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.requestId ?? null,
        e.ip ?? null,
        Date.now(),
      )
      .run();
  } catch (err) {
    // Never swallow silently: structured log so observability picks it up.
    console.error(
      JSON.stringify({ level: "error", msg: "audit_write_failed", action: e.action, err: String(err) }),
    );
  }
}
