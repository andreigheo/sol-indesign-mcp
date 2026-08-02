import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeBridgeError } from "../core/errors";
import { BRIDGE_PROTOCOL } from "./protocol";
import { WebSocketBridgeTransport } from "./websocket-transport";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static latest: FakeWebSocket | undefined;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCode: number | undefined;
  throwOnClose = false;
  rejectOnClose = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code = 1000): void | Promise<void> {
    if (this.throwOnClose) throw new Error("Host refused to close the failed socket.");
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.onclose?.(event as CloseEvent);
    if (this.rejectOnClose) {
      return Promise.reject(new Error("Host asynchronously refused to close the failed socket."));
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.onmessage?.(event as MessageEvent);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.latest = undefined;
});

describe("WebSocket bridge protocol failures", () => {
  it("opens the fixed localhost endpoint and sends hello as the first frame", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new WebSocketBridgeTransport();
    const connected = transport.connect({
      protocol: BRIDGE_PROTOCOL,
      type: "hello",
      supportedProtocols: [BRIDGE_PROTOCOL],
      pluginVersion: "0.1.0",
      inDesignVersion: "21.4.1",
      transport: "websocket",
      capabilities: {},
    }, {
      onFrame: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });

    await Promise.resolve();
    const socket = requireLatestSocket();
    expect(socket.url).toBe("ws://localhost:32145/bridge");
    expect(socket.sent).toHaveLength(0);
    socket.open();
    await connected;

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] ?? "null")).toMatchObject({
      protocol: BRIDGE_PROTOCOL,
      type: "hello",
      transport: "websocket",
    });
    await transport.close();
  });

  it("rejects an opening error and tolerates a host close failure", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new WebSocketBridgeTransport();
    const connected = transport.connect({
      protocol: BRIDGE_PROTOCOL,
      type: "hello",
      supportedProtocols: [BRIDGE_PROTOCOL],
      pluginVersion: "0.1.0",
      inDesignVersion: "21.4.1",
      transport: "websocket",
      capabilities: {},
    }, {
      onFrame: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    });
    await Promise.resolve();
    const socket = requireLatestSocket();
    expect(socket.url).toBe("ws://localhost:32145/bridge");
    socket.rejectOnClose = true;
    socket.fail();

    await expect(connected).rejects.toMatchObject({ code: "UXP_OPERATION_FAILED" });
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it("closes the session so the client can reconnect", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new WebSocketBridgeTransport();
    const errors: unknown[] = [];
    const closes: string[] = [];
    const connected = transport.connect({
      protocol: BRIDGE_PROTOCOL,
      type: "hello",
      supportedProtocols: [BRIDGE_PROTOCOL],
      pluginVersion: "0.1.0",
      inDesignVersion: "21.4.1",
      transport: "websocket",
      capabilities: {},
    }, {
      onFrame: () => { throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "invalid sequence"); },
      onClose: (reason) => { closes.push(reason); },
      onError: (error) => { errors.push(error); },
    });
    await Promise.resolve();
    const socket = requireLatestSocket();
    socket.open();
    await connected;

    socket.message(JSON.stringify({
      protocol: BRIDGE_PROTOCOL,
      type: "event",
      event: "heartbeat",
    }));

    await vi.waitFor(() => {
      expect(socket.closeCode).toBe(4002);
      expect(errors).toHaveLength(1);
      expect(closes).toHaveLength(1);
      expect(closes[0]).toContain("WebSocket closed (4002)");
    });
  });
});

function requireLatestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.latest;
  if (socket === undefined) throw new Error("Fake WebSocket was not constructed.");
  return socket;
}
