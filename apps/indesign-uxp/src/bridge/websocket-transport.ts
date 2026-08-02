import { decodeUtf8 } from "@sol/security/uxp";
import { SafeBridgeError } from "../core/errors";
import { parseBridgeFrame, serializeBridgeFrame } from "./protocol";
import type { BridgeFrame, BridgeHello } from "./protocol";
import type { BridgeTransport, BridgeTransportHandlers } from "./transport";

const WEBSOCKET_URL = "ws://localhost:32145/bridge";
const CONNECT_TIMEOUT_MS = 5_000;

export class WebSocketBridgeTransport implements BridgeTransport {
  readonly kind = "websocket" as const;
  #socket: WebSocket | undefined;
  #handlers: BridgeTransportHandlers | undefined;
  #intentionalClose = false;

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  async connect(hello: BridgeHello, handlers: BridgeTransportHandlers): Promise<void> {
    await this.close();
    this.#handlers = handlers;
    this.#intentionalClose = false;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(WEBSOCKET_URL);
      this.#socket = socket;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new SafeBridgeError("UXP_OPERATION_FAILED", "The WebSocket bridge did not open within 5 seconds.", { retryable: true }));
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (settled) return;
        try {
          socket.send(serializeBridgeFrame(hello));
          settled = true;
          clearTimeout(timeout);
          resolve();
        } catch (error) {
          settled = true;
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error("The WebSocket bridge could not send its hello frame."));
        }
      };

      socket.onmessage = (event) => {
        void this.#handleMessage(event.data);
      };

      socket.onerror = () => {
        const error = new SafeBridgeError("UXP_OPERATION_FAILED", "The WebSocket bridge reported a connection error.", { retryable: true });
        handlers.onError(error);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      };

      socket.onclose = (event) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new SafeBridgeError("UXP_OPERATION_FAILED", "The local WebSocket bridge is unavailable.", { retryable: true }));
        }
        this.#socket = undefined;
        if (!this.#intentionalClose) handlers.onClose(`WebSocket closed (${event.code}).`);
      };
    });
  }

  send(frame: BridgeFrame): Promise<void> {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", "The WebSocket bridge is not connected.", { retryable: true });
    }
    socket.send(serializeBridgeFrame(frame));
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.#intentionalClose = true;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#handlers = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      try {
        const closeResult: unknown = socket.close(1000, "panel disconnect");
        await Promise.resolve(closeResult);
      } catch {
        // Some UXP builds reject with a non-Error value while closing a failed socket.
      }
    }
  }

  async #handleMessage(data: unknown): Promise<void> {
    try {
      let payload: string;
      if (typeof data === "string") payload = data;
      else if (data instanceof ArrayBuffer) payload = decodeUtf8(new Uint8Array(data));
      else throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The bridge sent an unsupported WebSocket message type.");
      const frame = parseBridgeFrame(payload);
      await this.#handlers?.onFrame(frame);
    } catch (error) {
      this.#handlers?.onError(error);
      const socket = this.#socket;
      this.#intentionalClose = false;
      if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
        try {
          const closeResult: unknown = socket.close(4002, "protocol error");
          await Promise.resolve(closeResult);
        } catch {
          this.#socket = undefined;
        }
      }
    }
  }
}
