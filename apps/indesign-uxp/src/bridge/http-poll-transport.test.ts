import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PROTOCOL } from "./protocol";
import type { BridgeHello } from "./protocol";
import { HttpPollingBridgeTransport, parseHttpEnvelope } from "./http-poll-transport";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const HELLO: BridgeHello = {
  protocol: BRIDGE_PROTOCOL,
  type: "hello",
  supportedProtocols: [BRIDGE_PROTOCOL],
  pluginVersion: "0.1.0-test",
  inDesignVersion: "21.4.1-test",
  transport: "http",
  capabilities: {},
};

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("HTTP bridge envelopes", () => {
  it("maps malformed JSON and non-object envelopes to protocol errors", () => {
    expect(() => parseHttpEnvelope("{"))
      .toThrow(expect.objectContaining({ code: "BRIDGE_PROTOCOL_ERROR" }));
    expect(() => parseHttpEnvelope("[]"))
      .toThrow(expect.objectContaining({ code: "BRIDGE_PROTOCOL_ERROR" }));
  });

  it("accepts bounded object envelopes for strict field parsing", () => {
    expect(parseHttpEnvelope('{"frames":[]}')).toEqual({ frames: [] });
  });

  it("aborts a session fetch when its bounded connect deadline expires", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }));
    const transport = new HttpPollingBridgeTransport();
    const connecting = transport.connect(HELLO, {
      onFrame: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });

    const rejection = expect(connecting).rejects.toMatchObject({
      code: "UXP_OPERATION_FAILED",
      message: "HTTP bridge session exceeded its 10000 ms deadline.",
    });
    await Promise.resolve();
    expect(requests).toEqual(["http://localhost:32145/bridge/http/session"]);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("rejects an oversized declared HTTP response before parsing frames", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", {
      status: 201,
      headers: { "content-length": String((8 * 1024 * 1024) + 1) },
    }))));
    const transport = new HttpPollingBridgeTransport();

    await expect(transport.connect(HELLO, {
      onFrame: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })).rejects.toMatchObject({
      code: "BRIDGE_PROTOCOL_ERROR",
      message: "The HTTP bridge response exceeds the 8 MiB limit.",
    });
  });

  it("uses the exact session, poll, send, and close endpoints with encoded client IDs", async () => {
    const requests: { url: string; method: string; headers: Headers; body: string | undefined }[] = [];
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/session") && method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ clientId: "client /?&", frames: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }));
      }
      if (url.includes("/poll?") && method === "GET") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("intentional close")), { once: true });
        });
      }
      if (url.includes("/send?") && method === "POST") {
        return Promise.resolve(new Response("{}", { status: 202 }));
      }
      if (url.includes("/session?") && method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
    }));
    const transport = new HttpPollingBridgeTransport();

    await transport.connect(HELLO, { onFrame: vi.fn(), onClose: vi.fn(), onError });
    await vi.waitFor(() => expect(requests.some((request) => request.url.includes("/poll?"))).toBe(true));
    expect(transport.connected).toBe(true);
    await transport.send({ protocol: BRIDGE_PROTOCOL, type: "event", event: "heartbeat_ack" });
    await transport.close();

    const encoded = "client%20%2F%3F%26";
    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "http://localhost:32145/bridge/http/session", method: "POST" },
      { url: `http://localhost:32145/bridge/http/poll?clientId=${encoded}`, method: "GET" },
      { url: `http://localhost:32145/bridge/http/send?clientId=${encoded}`, method: "POST" },
      { url: `http://localhost:32145/bridge/http/session?clientId=${encoded}`, method: "DELETE" },
    ]);
    expect(JSON.parse(requests[0]?.body ?? "null")).toMatchObject({ type: "hello", transport: "http" });
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(requests[1]?.headers.get("accept")).toBe("application/json");
    expect(JSON.parse(requests[2]?.body ?? "null")).toMatchObject({ type: "event", event: "heartbeat_ack" });
    expect(transport.connected).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops after exactly three consecutive poll failures", async () => {
    vi.useFakeTimers();
    let pollCalls = 0;
    const onError = vi.fn();
    const onClose = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/session") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ clientId: "bounded-client", frames: [] }), { status: 201 }));
      }
      if (url.includes("/poll?") && init?.method === "GET") {
        pollCalls += 1;
        return Promise.resolve(new Response("{}", { status: 503 }));
      }
      if (url.includes("/session?") && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`));
    }));
    const transport = new HttpPollingBridgeTransport();

    await transport.connect(HELLO, { onFrame: vi.fn(), onClose, onError });
    await Promise.resolve();
    expect(pollCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(pollCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(pollCalls).toBe(3);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onClose).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollCalls).toBe(3);
    await transport.close();
  });
});
