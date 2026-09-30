import { describe, expect, it, vi } from "vitest";
import { ApiClientError, createApiClient } from "../src/index";

describe("api client", () => {
  it("sends bearer token and parses JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mode: "PAPER" }), { status: 200 }));
    const api = createApiClient({
      baseUrl: "https://api.x/",
      getToken: () => "tok",
      fetch: fetchMock as never,
    });
    const r = await api.account();
    expect(r.mode).toBe("PAPER");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x/api/v1/account");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("maps structured errors and calls onUnauthorized on 401", async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "no" } }), { status: 401 }),
    );
    const api = createApiClient({
      baseUrl: "https://api.x",
      getToken: () => null,
      onUnauthorized,
      fetch: fetchMock as never,
    });
    await expect(api.portfolio()).rejects.toBeInstanceOf(ApiClientError);
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("builds a wss realtime url", () => {
    const api = createApiClient({ baseUrl: "https://api.x", getToken: () => null });
    expect(api.realtimeUrl("a b")).toBe("wss://api.x/api/v1/system/realtime?token=a%20b");
  });
});
