import { SafeBridgeError } from "../core/errors";
import { isRecord } from "../core/records";
import { utf8ByteLength } from "@sol/security/uxp";
import { BRIDGE_MAX_FRAME_BYTES, parseBridgeFrame, serializeBridgeFrame } from "./protocol";
import type { BridgeFrame, BridgeHello } from "./protocol";
import type { BridgeTransport, BridgeTransportHandlers } from "./transport";

const BASE_URL = "http://localhost:32145/bridge/http";
const POLL_RETRY_LIMIT = 3;
const CONNECT_DEADLINE_MS = 10_000;
const SEND_DEADLINE_MS = 10_000;
const POLL_DEADLINE_MS = 30_000;
const CLOSE_DEADLINE_MS = 3_000;

export class HttpPollingBridgeTransport implements BridgeTransport {
  readonly kind = "http-poll" as const;
  #clientId: string | undefined;
  #handlers: BridgeTransportHandlers | undefined;
  #abortController: AbortController | undefined;
  #polling = false;

  get connected(): boolean {
    return this.#clientId !== undefined && this.#polling;
  }

  async connect(hello: BridgeHello, handlers: BridgeTransportHandlers): Promise<void> {
    await this.close();
    this.#handlers = handlers;
    this.#abortController = new AbortController();
    const { response, payload } = await fetchBoundedResponse(
      `${BASE_URL}/session`,
      {
        method: "POST",
        headers: requestHeaders([["content-type", "application/json"]]),
        body: serializeBridgeFrame(hello),
      },
      CONNECT_DEADLINE_MS,
      this.#abortController.signal,
      "HTTP bridge session",
    );
    if (!response.ok) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", `The HTTP bridge rejected the session (${response.status}).`, { retryable: true });
    }
    const record = parseHttpEnvelope(payload);
    this.#clientId = requiredClientId(record.clientId);
    await dispatchEmbeddedFrames(record.frames, handlers);
    this.#polling = true;
    void this.#pollLoop();
  }

  async send(frame: BridgeFrame): Promise<void> {
    const clientId = this.#clientId;
    if (clientId === undefined) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", "The HTTP bridge is not connected.", { retryable: true });
    }
    const { response } = await fetchBoundedResponse(
      `${BASE_URL}/send?clientId=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: requestHeaders([["content-type", "application/json"]]),
        body: serializeBridgeFrame(frame),
      },
      SEND_DEADLINE_MS,
      this.#abortController?.signal,
      "HTTP bridge send",
    );
    if (!response.ok) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", `The HTTP bridge rejected a frame (${response.status}).`, { retryable: true });
    }
  }

  async close(): Promise<void> {
    const clientId = this.#clientId;
    this.#clientId = undefined;
    this.#polling = false;
    this.#abortController?.abort();
    this.#abortController = undefined;
    if (clientId !== undefined) {
      try {
        await fetchWithDeadline(
          `${BASE_URL}/session?clientId=${encodeURIComponent(clientId)}`,
          { method: "DELETE" },
          CLOSE_DEADLINE_MS,
          undefined,
          "HTTP bridge close",
        );
      } catch {
        // A best-effort close must not delay panel teardown.
      }
    }
  }

  async #pollLoop(): Promise<void> {
    let consecutiveFailures = 0;
    const lifetimeSignal = this.#abortController?.signal;
    while (this.#polling && this.#clientId !== undefined) {
      try {
        const { response, payload: body } = await fetchBoundedResponse(
          `${BASE_URL}/poll?clientId=${encodeURIComponent(this.#clientId)}`,
          { method: "GET", headers: requestHeaders([["accept", "application/json"]]) },
          POLL_DEADLINE_MS,
          lifetimeSignal,
          "HTTP bridge poll",
        );
        if (!response.ok) throw new Error(`poll status ${response.status}`);
        const record = parseHttpEnvelope(body);
        await dispatchEmbeddedFrames(record.frames, this.#handlers);
        consecutiveFailures = 0;
      } catch (error) {
        if (lifetimeSignal?.aborted === true) return;
        consecutiveFailures += 1;
        this.#handlers?.onError(error);
        if (error instanceof SafeBridgeError && error.code === "BRIDGE_PROTOCOL_ERROR") {
          this.#polling = false;
          this.#handlers?.onClose("HTTP long polling stopped after a bridge protocol error.");
          return;
        }
        if (consecutiveFailures >= POLL_RETRY_LIMIT) {
          this.#polling = false;
          this.#handlers?.onClose("HTTP long polling stopped after three failures.");
          return;
        }
        await delay(250 * consecutiveFailures);
      }
    }
  }
}

interface BoundedHttpResponse {
  readonly response: Response;
  readonly payload: string;
}

async function fetchBoundedResponse(
  input: string,
  init: RequestInit,
  deadlineMs: number,
  lifetimeSignal: AbortSignal | undefined,
  operation: string,
): Promise<BoundedHttpResponse> {
  return await withAbortDeadline(deadlineMs, lifetimeSignal, operation, async (signal) => {
    const response = await fetch(input, { ...init, signal });
    const payload = await readBoundedBody(response);
    return { response, payload };
  });
}

async function fetchWithDeadline(
  input: string,
  init: RequestInit,
  deadlineMs: number,
  lifetimeSignal: AbortSignal | undefined,
  operation: string,
): Promise<Response> {
  return await withAbortDeadline(
    deadlineMs,
    lifetimeSignal,
    operation,
    async (signal) => await fetch(input, { ...init, signal }),
  );
}

async function withAbortDeadline<Result>(
  deadlineMs: number,
  lifetimeSignal: AbortSignal | undefined,
  operation: string,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  const deadline = { exceeded: false };
  const abortForLifetime = (): void => controller.abort();
  if (lifetimeSignal?.aborted === true) controller.abort();
  else lifetimeSignal?.addEventListener("abort", abortForLifetime, { once: true });
  const timer = setTimeout(() => {
    deadline.exceeded = true;
    controller.abort();
  }, deadlineMs);
  try {
    return await run(controller.signal);
  } catch (error: unknown) {
    if (deadline.exceeded) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", `${operation} exceeded its ${deadlineMs} ms deadline.`, { retryable: true });
    }
    if (lifetimeSignal?.aborted === true) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", `${operation} was cancelled because the bridge session closed.`, { retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    lifetimeSignal?.removeEventListener("abort", abortForLifetime);
  }
}

async function dispatchEmbeddedFrames(value: unknown, handlers: BridgeTransportHandlers | undefined): Promise<void> {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "HTTP bridge frames must be an array.");
  for (const raw of value) {
    const frame = parseBridgeFrame(typeof raw === "string" ? raw : JSON.stringify(raw));
    await handlers?.onFrame(frame);
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > BRIDGE_MAX_FRAME_BYTES) {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The HTTP bridge response exceeds the 8 MiB limit.");
  }
  const body = await response.text();
  if (utf8ByteLength(body) > BRIDGE_MAX_FRAME_BYTES) {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The HTTP bridge response exceeds the 8 MiB limit.");
  }
  return body;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestHeaders(entries: readonly (readonly [string, string])[]): Headers {
  const headers = new Headers();
  for (const [name, value] of entries) headers.set(name, value);
  return headers;
}

export function parseHttpEnvelope(payload: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload) as unknown;
  } catch {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The HTTP bridge sent invalid JSON.");
  }
  if (!isRecord(decoded)) {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The HTTP bridge response must be an object.");
  }
  return decoded;
}

function requiredClientId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The HTTP bridge session response has an invalid client ID.");
  }
  return value;
}
