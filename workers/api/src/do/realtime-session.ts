import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export type RealtimeTopic = "price" | "signal" | "position" | "order" | "pnl" | "risk" | "alert";

/**
 * WebSocket fan-out using the Hibernation API (idle sockets cost nothing).
 * Clients connect via /api/v1/system/realtime (auth checked in the Worker before upgrade).
 */
export class RealtimeSessionDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", at: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
    // Clients are read-only: no trading commands accepted over the socket.
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code, "closing");
  }

  async broadcast(topic: RealtimeTopic, data: unknown): Promise<number> {
    const msg = JSON.stringify({ type: topic, data, at: Date.now() });
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        // socket already gone
      }
    }
    return sockets.length;
  }
}
