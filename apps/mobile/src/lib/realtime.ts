import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "../stores/account";
import { useAuth } from "../stores/auth";
import { api, qk } from "./api";

type Status = "connecting" | "open" | "closed";

const TOPIC_TO_QUERY: Record<string, readonly (readonly string[])[]> = {
  position: [qk.positions, qk.portfolio],
  order: [qk.orders],
  pnl: [qk.portfolio],
  risk: [qk.risk, qk.portfolio],
  signal: [qk.signals],
  alert: [qk.account, qk.portfolio],
};

/** Single WebSocket subscription; pushes invalidate React Query caches (no aggressive polling). */
export function useRealtime(): Status {
  const token = useAuth((s) => s.token);
  const account = useAccount((s) => s.account);
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("closed");
  const retry = useRef(0);

  useEffect(() => {
    if (!token) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const connect = () => {
      setStatus("connecting");
      ws = new WebSocket(api.realtimeUrl(token, account));
      ws.onopen = () => {
        retry.current = 0;
        setStatus("open");
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type: string };
          for (const key of TOPIC_TO_QUERY[msg.type] ?? []) void qc.invalidateQueries({ queryKey: key });
        } catch {
          /* ignore non-JSON (pong) */
        }
      };
      ws.onclose = () => {
        setStatus("closed");
        if (!alive) return;
        const delay = Math.min(30_000, 1000 * 2 ** retry.current++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [token, account, qc]);

  return status;
}
