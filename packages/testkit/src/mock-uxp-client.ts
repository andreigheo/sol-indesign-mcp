import { createHmac } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import * as z from "zod/v4";
import {
  BRIDGE_PROTOCOL,
  BridgeChallengeSchema,
  BridgeErrorSchema,
  BridgeFrameSchema,
  type BridgeAuthentication,
  type BridgeEvent,
  type BridgeFrame,
  type BridgeHello,
  type BridgeRequest,
  type BridgeResponse,
  SolBridgeError,
} from "@sol/protocol";
import type { BridgeDispatcher } from "./fake-adapter.js";

const HttpSessionResponseSchema = z.strictObject({
  clientId: z.string().min(1),
  frames: z.array(BridgeFrameSchema),
});
const HttpPollResponseSchema = z.strictObject({ frames: z.array(BridgeFrameSchema) });

interface MockClientOptions {
  readonly baseUrl: string;
  readonly token: Uint8Array;
  readonly dispatcher: BridgeDispatcher;
  readonly authenticationAttempts?: number;
}

function hello(transport: "websocket" | "http"): BridgeHello {
  return {
    protocol: BRIDGE_PROTOCOL,
    type: "hello",
    supportedProtocols: [BRIDGE_PROTOCOL],
    pluginVersion: "0.1.0-test",
    inDesignVersion: "21.4.1-test",
    transport,
    capabilities: {
      doScript: { status: "runtimeProbed", reason: "mock UXP" },
      preflight: { status: "runtimeProbed", reason: "mock UXP" },
    },
  };
}

function authentication(token: Uint8Array, challenge: z.infer<typeof BridgeChallengeSchema>): BridgeAuthentication {
  return {
    protocol: BRIDGE_PROTOCOL,
    type: "authentication",
    sessionId: challenge.sessionId,
    digest: createHmac("sha256", token).update(challenge.nonce, "utf8").digest("base64url"),
  };
}

function rawDataToText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function failureResponse(request: BridgeRequest, error: unknown): BridgeResponse {
  const bridgeError = error instanceof SolBridgeError
    ? error.toBridgeError()
    : BridgeErrorSchema.parse({
      code: "INTERNAL_ERROR",
      message: "The mock UXP adapter could not complete the request.",
      traceId: request.meta.traceId,
      retryable: false,
    });
  return {
    protocol: BRIDGE_PROTOCOL,
    type: "response",
    id: request.id,
    ok: false,
    error: bridgeError,
  };
}

async function dispatchResponse(dispatcher: BridgeDispatcher, request: BridgeRequest): Promise<BridgeResponse> {
  try {
    const result = await dispatcher.dispatch(request);
    return { protocol: BRIDGE_PROTOCOL, type: "response", id: request.id, ok: true, result };
  } catch (error: unknown) {
    return failureResponse(request, error);
  }
}

export class AuthenticatedMockUxpClient {
  readonly #options: MockClientOptions;
  readonly events: BridgeEvent[] = [];
  readonly requests: BridgeRequest[] = [];
  #socket: WebSocket | undefined;
  #authenticated = false;
  #requestChain: Promise<void> = Promise.resolve();

  constructor(options: MockClientOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#socket !== undefined) throw new Error("The mock UXP WebSocket client is already connected.");
    const socket = new WebSocket(`${this.#options.baseUrl}/bridge`);
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out authenticating the mock UXP WebSocket client."));
      }, 5_000);
      timer.unref();
      socket.once("open", () => this.#send(hello("websocket")));
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", () => {
        if (!this.#authenticated) {
          clearTimeout(timer);
          reject(new Error("The mock UXP WebSocket closed before authentication."));
        }
      });
      socket.on("message", (raw: RawData) => {
        let frame: BridgeFrame;
        try {
          frame = BridgeFrameSchema.parse(JSON.parse(rawDataToText(raw)) as unknown);
        } catch (error: unknown) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("The mock UXP client received an invalid bridge frame."));
          return;
        }
        if (frame.type === "challenge") {
          const auth = authentication(this.#options.token, frame);
          const attempts = this.#options.authenticationAttempts ?? 1;
          for (let index = 0; index < attempts; index += 1) this.#send(auth);
          return;
        }
        if (frame.type === "event" && frame.event === "authenticated") {
          this.#authenticated = true;
          this.events.push(frame);
          clearTimeout(timer);
          resolve();
          return;
        }
        this.#acceptOperationalFrame(frame);
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#authenticated = false;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, "Mock test complete");
    });
  }

  #acceptOperationalFrame(frame: BridgeFrame): void {
    if (frame.type === "request") {
      this.requests.push(frame);
      this.#requestChain = this.#requestChain.then(async () => {
        const response = await dispatchResponse(this.#options.dispatcher, frame);
        if (this.#socket?.readyState === WebSocket.OPEN) this.#send(response);
      });
      return;
    }
    if (frame.type === "event") {
      this.events.push(frame);
      if (frame.event === "heartbeat") {
        this.#send({ protocol: BRIDGE_PROTOCOL, type: "event", event: "heartbeat_ack" });
      }
    }
  }

  #send(frame: BridgeFrame): void {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error("The mock UXP WebSocket is not open.");
    }
    socket.send(JSON.stringify(BridgeFrameSchema.parse(frame)));
  }
}

export class AuthenticatedMockHttpUxpClient {
  readonly #options: MockClientOptions;
  readonly events: BridgeEvent[] = [];
  readonly requests: BridgeRequest[] = [];
  #clientId: string | undefined;
  #authenticated = false;
  #closing = false;
  #pollController: AbortController | undefined;
  #pollPromise: Promise<void> | undefined;

  constructor(options: MockClientOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#clientId !== undefined) throw new Error("The mock UXP HTTP client is already connected.");
    const response = await fetch(`${this.#options.baseUrl}/bridge/http/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hello("http")),
    });
    if (response.status !== 201) throw new Error(`HTTP bridge session failed with status ${response.status}.`);
    const session = HttpSessionResponseSchema.parse(await response.json() as unknown);
    this.#clientId = session.clientId;
    const challengeFrame = session.frames.find((frame) => frame.type === "challenge");
    const challenge = BridgeChallengeSchema.parse(challengeFrame);
    await this.#send(authentication(this.#options.token, challenge));
    this.#pollController = new AbortController();
    this.#pollPromise = this.#pollLoop(this.#pollController.signal);
    const started = Date.now();
    while (!this.#authenticated) {
      if (Date.now() - started > 5_000) throw new Error("Timed out authenticating the mock UXP HTTP client.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  async close(): Promise<void> {
    const clientId = this.#clientId;
    this.#closing = true;
    if (clientId !== undefined) {
      await fetch(`${this.#options.baseUrl}/bridge/http/session?clientId=${encodeURIComponent(clientId)}`, { method: "DELETE" }).catch(() => undefined);
    }
    this.#pollController?.abort();
    await this.#pollPromise?.catch(() => undefined);
    this.#clientId = undefined;
    this.#authenticated = false;
  }

  async #pollLoop(signal: AbortSignal): Promise<void> {
    while (!this.#closing) {
      const clientId = this.#requiredClientId();
      try {
        const response = await fetch(`${this.#options.baseUrl}/bridge/http/poll?clientId=${encodeURIComponent(clientId)}`, { signal });
        if (!response.ok) {
          throw new Error(`HTTP bridge poll failed with status ${response.status}.`);
        }
        const poll = HttpPollResponseSchema.parse(await response.json() as unknown);
        for (const frame of poll.frames) await this.#acceptFrame(frame);
      } catch (error: unknown) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }

  async #acceptFrame(frame: BridgeFrame): Promise<void> {
    if (frame.type === "event") {
      this.events.push(frame);
      if (frame.event === "authenticated") this.#authenticated = true;
      if (frame.event === "heartbeat") {
        await this.#send({ protocol: BRIDGE_PROTOCOL, type: "event", event: "heartbeat_ack" });
      }
      return;
    }
    if (frame.type === "request") {
      this.requests.push(frame);
      await this.#send(await dispatchResponse(this.#options.dispatcher, frame));
    }
  }

  async #send(frame: BridgeFrame): Promise<void> {
    const clientId = this.#requiredClientId();
    const response = await fetch(`${this.#options.baseUrl}/bridge/http/send?clientId=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BridgeFrameSchema.parse(frame)),
    });
    if (response.status !== 202) throw new Error(`HTTP bridge send failed with status ${response.status}.`);
  }

  #requiredClientId(): string {
    if (this.#clientId === undefined) throw new Error("The mock UXP HTTP session has not been created.");
    return this.#clientId;
  }
}
