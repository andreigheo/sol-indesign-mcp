import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./client";
import { BRIDGE_PROTOCOL } from "./protocol";
import type { BridgeFrame, BridgeHello } from "./protocol";
import type { BridgeTransport, BridgeTransportHandlers } from "./transport";

const VECTOR_TOKEN = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const VECTOR_NONCE = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const VECTOR_DIGEST = "HTnaKRqCdzA0ClJsKMnqW1K3geYWtfVE45Wpaoxz8JA";

class PendingTransport implements BridgeTransport {
  readonly kind = "websocket" as const;
  readonly connected = false;
  connectCalls = 0;
  closeCalls = 0;

  connect(): Promise<void> {
    this.connectCalls += 1;
    return new Promise(() => undefined);
  }

  send(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

class ChallengeTransport implements BridgeTransport {
  readonly kind = "websocket" as const;
  readonly connected = true;
  readonly sent: BridgeFrame[] = [];
  #handlers: BridgeTransportHandlers | undefined;

  async connect(_hello: BridgeHello, handlers: BridgeTransportHandlers): Promise<void> {
    this.#handlers = handlers;
    await this.challenge(VECTOR_NONCE);
  }

  send(frame: BridgeFrame): Promise<void> {
    this.sent.push(frame);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async challenge(nonce: string): Promise<void> {
    await this.#handlers?.onFrame({
      protocol: BRIDGE_PROTOCOL,
      type: "challenge",
      sessionId: VECTOR_TOKEN,
      nonce,
      expiresAt: Date.now() + 15_000,
    });
  }
}

class RejectedWebSocketTransport implements BridgeTransport {
  readonly kind = "websocket" as const;
  readonly connected = false;

  connect(): Promise<void> {
    return Promise.reject(new Error("The diagnostic WebSocket attempt was rejected."));
  }

  send(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class AuthenticatingHttpTransport implements BridgeTransport {
  readonly kind = "http-poll" as const;
  readonly connected = true;
  readonly sent: BridgeFrame[] = [];
  hello: BridgeHello | undefined;
  #handlers: BridgeTransportHandlers | undefined;

  async connect(hello: BridgeHello, handlers: BridgeTransportHandlers): Promise<void> {
    this.hello = hello;
    this.#handlers = handlers;
    await handlers.onFrame({
      protocol: BRIDGE_PROTOCOL,
      type: "challenge",
      sessionId: VECTOR_TOKEN,
      nonce: VECTOR_NONCE,
      expiresAt: Date.now() + 15_000,
    });
  }

  send(frame: BridgeFrame): Promise<void> {
    this.sent.push(frame);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async authenticate(): Promise<void> {
    await this.#handlers?.onFrame({
      protocol: BRIDGE_PROTOCOL,
      type: "event",
      event: "authenticated",
    });
  }

  closeFromServer(): void {
    this.#handlers?.onClose("HTTP diagnostic session closed.");
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BridgeClient connection intent", () => {
  it("keeps a manual disconnect suppressed until an explicit Connect action", async () => {
    const getToken = vi.fn(() => Promise.resolve(undefined));
    const stateChanged = vi.fn();
    const diagnostics = { add: vi.fn() };
    const router = {
      handle: vi.fn(),
      statusPayload: vi.fn(),
      cancel: vi.fn(),
    };
    const client = new BridgeClient({
      secrets: { getToken },
      router,
      diagnostics,
      helloSnapshot: vi.fn(),
      stateChanged,
    });

    await client.stop();
    client.start();
    await Promise.resolve();
    expect(getToken).not.toHaveBeenCalled();

    client.start(true);
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledOnce());
    expect(client.state()).toMatchObject({ phase: "offline", authenticated: false });
  });

  it("restarts a pending transport immediately for an explicit Retry", async () => {
    vi.stubGlobal("__SOL_PLUGIN_VERSION__", "0.1.0");
    const first = new PendingTransport();
    const second = new PendingTransport();
    const transports = [first, second];
    const client = new BridgeClient({
      secrets: { getToken: vi.fn(() => Promise.resolve("A".repeat(43))) },
      router: { handle: vi.fn(), statusPayload: vi.fn(), cancel: vi.fn() },
      diagnostics: { add: vi.fn() },
      helloSnapshot: vi.fn(() => Promise.resolve({ inDesignVersion: "21.4.1", capabilities: {} })),
      stateChanged: vi.fn(),
      transportFactory: () => {
        const transport = transports.shift();
        if (transport === undefined) throw new Error("Unexpected transport request");
        return transport;
      },
    });

    client.start();
    await vi.waitFor(() => expect(first.connectCalls).toBe(1));
    client.start(true);
    await vi.waitFor(() => expect(second.connectCalls).toBe(1));

    expect(first.closeCalls).toBe(1);
    expect(client.state().phase).toBe("connecting");
    await client.stop();
  });

  it("continues opening the transport when the host UI renderer fails", async () => {
    vi.stubGlobal("__SOL_PLUGIN_VERSION__", "0.1.0");
    const transport = new PendingTransport();
    const diagnostics = { add: vi.fn() };
    const client = new BridgeClient({
      secrets: { getToken: vi.fn(() => Promise.resolve("A".repeat(43))) },
      router: { handle: vi.fn(), statusPayload: vi.fn(), cancel: vi.fn() },
      diagnostics,
      helloSnapshot: vi.fn(() => Promise.resolve({ inDesignVersion: "21.4.1", capabilities: {} })),
      stateChanged: () => { throw new Error("Host renderer rejected the update."); },
      transportFactory: () => transport,
    });

    client.start();
    await vi.waitFor(() => expect(transport.connectCalls).toBe(1));

    expect(diagnostics.add).toHaveBeenCalledWith("warning", "panel.render-failed");
    await client.stop();
  });

  it("uses the portable HMAC implementation and accepts a retry challenge", async () => {
    vi.stubGlobal("__SOL_PLUGIN_VERSION__", "0.1.0");
    vi.stubGlobal("atob", () => { throw new Error("Browser base64 is unavailable."); });
    vi.stubGlobal("btoa", () => { throw new Error("Browser base64 is unavailable."); });
    const transport = new ChallengeTransport();
    const diagnostics = { add: vi.fn() };
    const client = new BridgeClient({
      secrets: { getToken: vi.fn(() => Promise.resolve(VECTOR_TOKEN)) },
      router: { handle: vi.fn(), statusPayload: vi.fn(), cancel: vi.fn() },
      diagnostics,
      helloSnapshot: vi.fn(() => Promise.resolve({ inDesignVersion: "21.4.1", capabilities: {} })),
      stateChanged: vi.fn(),
      transportFactory: () => transport,
    });

    client.start();
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0]).toMatchObject({
      type: "authentication",
      sessionId: VECTOR_TOKEN,
      digest: VECTOR_DIGEST,
    });

    await transport.challenge(VECTOR_NONCE);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]).toMatchObject({ type: "authentication", digest: VECTOR_DIGEST });
    expect(diagnostics.add).toHaveBeenCalledWith("warning", "bridge.authentication-retry");
    await client.stop();
  });

  it("switches to HTTP after exactly three WebSocket failures and resets after authentication", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("__SOL_PLUGIN_VERSION__", "0.1.0");
    const selections: boolean[] = [];
    const http = new AuthenticatingHttpTransport();
    const restoredWebSocket = new PendingTransport();
    let webSocketAttempts = 0;
    const client = new BridgeClient({
      secrets: { getToken: vi.fn(() => Promise.resolve(VECTOR_TOKEN)) },
      router: { handle: vi.fn(), statusPayload: vi.fn(), cancel: vi.fn() },
      diagnostics: { add: vi.fn() },
      helloSnapshot: vi.fn(() => Promise.resolve({ inDesignVersion: "21.4.1", capabilities: {} })),
      stateChanged: vi.fn(),
      transportFactory: (useHttp) => {
        selections.push(useHttp);
        if (useHttp) return http;
        webSocketAttempts += 1;
        return webSocketAttempts <= 3 ? new RejectedWebSocketTransport() : restoredWebSocket;
      },
    });

    client.start();
    await settlePromises();
    expect(selections).toEqual([false]);
    await vi.advanceTimersByTimeAsync(500);
    expect(selections).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(650);
    expect(selections).toEqual([false, false, false]);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(selections).toEqual([false, false, false, true]);
    expect(http.hello).toMatchObject({ type: "hello", transport: "http" });
    expect(http.sent).toContainEqual(expect.objectContaining({ type: "authentication", digest: VECTOR_DIGEST }));

    await http.authenticate();
    expect(client.state()).toMatchObject({ phase: "authenticated", authenticated: true, transport: "http-poll" });
    http.closeFromServer();
    await settlePromises();
    await vi.advanceTimersByTimeAsync(500);

    expect(selections).toEqual([false, false, false, true, false]);
    expect(restoredWebSocket.connectCalls).toBe(1);
    await client.stop();
  });
});

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
