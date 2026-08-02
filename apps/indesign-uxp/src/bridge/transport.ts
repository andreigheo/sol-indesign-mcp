import type { BridgeFrame, BridgeHello } from "./protocol";

export type TransportKind = "websocket" | "http-poll";

export interface BridgeTransportHandlers {
  onFrame(frame: BridgeFrame): void | Promise<void>;
  onClose(reason: string): void;
  onError(error: unknown): void;
}

export interface BridgeTransport {
  readonly kind: TransportKind;
  readonly connected: boolean;
  connect(hello: BridgeHello, handlers: BridgeTransportHandlers): Promise<void>;
  send(frame: BridgeFrame): Promise<void>;
  close(): Promise<void>;
}
