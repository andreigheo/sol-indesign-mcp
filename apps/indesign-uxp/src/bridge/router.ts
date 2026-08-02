import { BoundedDetailsSchema, PluginStatusResultSchema } from "@sol/protocol";
import type { BridgeError as ProtocolBridgeError, PluginStatusResult } from "@sol/protocol";
import type { SafeErrorShape } from "../core/errors";
import { toSafeError } from "../core/errors";
import type { DiagnosticRing } from "../diagnostics/diagnostic-ring";
import type { SerialRequestQueue } from "../queue/serial-request-queue";
import type { SolInDesignAdapter } from "../adapter/indesign-adapter";
import { BRIDGE_PROTOCOL } from "./protocol";
import type { BridgeRequest, BridgeResponse } from "./protocol";

export class BridgeRequestRouter {
  readonly #adapter: SolInDesignAdapter;
  readonly #queue: SerialRequestQueue;
  readonly #diagnostics: DiagnosticRing;

  constructor(adapter: SolInDesignAdapter, queue: SerialRequestQueue, diagnostics: DiagnosticRing) {
    this.#adapter = adapter;
    this.#queue = queue;
    this.#diagnostics = diagnostics;
  }

  async handle(request: BridgeRequest): Promise<BridgeResponse> {
    try {
      const result = await this.#queue.enqueue(
        request.id,
        request.meta.deadlineMs,
        () => this.#adapter.execute(request.method, request.params, {
          requestId: request.id,
          traceId: request.meta.traceId,
        }),
      );
      const responseResult = request.method === "indesign.status" && typeof result === "object" && result !== null
        ? { ...result, queueDepth: Math.max(0, this.#queue.depth - 1) }
        : result;
      this.#diagnostics.add("info", "request.completed", { method: request.method, requestId: request.id });
      return { protocol: BRIDGE_PROTOCOL, type: "response", id: request.id, ok: true, result: responseResult };
    } catch (error) {
      const safe = toSafeError(error);
      this.#diagnostics.add("error", "request.failed", { method: request.method, requestId: request.id, code: safe.code });
      return {
        protocol: BRIDGE_PROTOCOL,
        type: "response",
        id: request.id,
        ok: false,
        error: mapProtocolError(safe.toSafeShape(), request.meta.traceId),
      };
    }
  }

  async statusPayload(): Promise<PluginStatusResult> {
    const result = await this.#queue.enqueue(
      `status-${Date.now()}`,
      3_000,
      () => this.#adapter.execute("indesign.status", {}),
    );
    if (typeof result !== "object" || result === null) {
      return PluginStatusResultSchema.parse(result);
    }
    return PluginStatusResultSchema.parse({ ...result, queueDepth: Math.max(0, this.#queue.depth - 1) });
  }

  cancel(requestId: string): "queued" | "active" | "missing" {
    const result = this.#queue.cancel(requestId);
    this.#diagnostics.add("info", "request.cancel", { requestId, result });
    return result;
  }
}

export function mapProtocolError(error: SafeErrorShape, traceId: string): ProtocolBridgeError {
  const code: ProtocolBridgeError["code"] = (() => {
    switch (error.code) {
      case "AUTHENTICATION_REQUIRED":
      case "AUTHENTICATION_FAILED": return "BRIDGE_AUTH_FAILED";
      case "BRIDGE_PROTOCOL_ERROR": return "BRIDGE_PROTOCOL_MISMATCH";
      case "CANCELLED": return "CANCELLED";
      case "DEADLINE_EXCEEDED": return "TIMEOUT";
      case "DOCUMENT_MISMATCH": return "DOCUMENT_MISMATCH";
      case "DOCUMENT_NOT_FOUND": return "DOCUMENT_NOT_FOUND";
      case "FILE_EXISTS": return "FILE_EXISTS";
      case "FILE_NOT_FOUND": return "FILE_NOT_FOUND";
      case "FONT_NOT_FOUND": return "FONT_NOT_FOUND";
      case "INVALID_INPUT": return "VALIDATION_ERROR";
      case "ITEM_NOT_FOUND": return "OBJECT_NOT_FOUND";
      case "PATH_NOT_ALLOWED": return "PATH_NOT_ALLOWED";
      case "PARTIAL_FAILURE": return "PARTIAL_FAILURE";
      case "PRESET_NOT_FOUND": return "PRESET_NOT_FOUND";
      case "STALE_DOCUMENT": return "STALE_DOCUMENT";
      case "STALE_OBJECT": return "OBJECT_STALE";
      case "STYLE_NOT_FOUND": return "STYLE_NOT_FOUND";
      case "UNSUPPORTED_CAPABILITY": return "UNSUPPORTED_CAPABILITY";
      case "WORKSPACE_REQUIRED": return "WORKSPACE_NOT_AUTHORIZED";
      case "UXP_OPERATION_FAILED": return "DOM_ERROR";
    }
  })();
  const parsedDetails = error.details === undefined ? undefined : BoundedDetailsSchema.safeParse(error.details);
  const details = parsedDetails === undefined
    ? undefined
    : parsedDetails.success ? parsedDetails.data : { omitted: "Error details exceeded protocol bounds." };
  return {
    code,
    message: error.message,
    traceId,
    retryable: error.retryable,
    ...(details === undefined ? {} : { details }),
  };
}
