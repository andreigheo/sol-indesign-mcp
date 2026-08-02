import * as z from "zod/v4";
import { BoundedDetailsSchema } from "./common.js";

export const BridgeErrorCodeSchema = z.enum([
  "BRIDGE_OFFLINE",
  "BRIDGE_AUTH_FAILED",
  "BRIDGE_PROTOCOL_MISMATCH",
  "BRIDGE_ALREADY_CONNECTED",
  "BRIDGE_BUSY",
  "INDESIGN_UNAVAILABLE",
  "NO_DOCUMENT",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_MISMATCH",
  "STALE_DOCUMENT",
  "OBJECT_NOT_FOUND",
  "OBJECT_STALE",
  "UNSUPPORTED_CAPABILITY",
  "VALIDATION_ERROR",
  "WORKSPACE_NOT_AUTHORIZED",
  "PATH_NOT_ALLOWED",
  "FILE_EXISTS",
  "FILE_NOT_FOUND",
  "FONT_NOT_FOUND",
  "STYLE_NOT_FOUND",
  "PRESET_NOT_FOUND",
  "MESSAGE_TOO_LARGE",
  "TIMEOUT",
  "CANCELLED",
  "DOM_ERROR",
  "PARTIAL_FAILURE",
  "INTERNAL_ERROR",
]);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCodeSchema>;

export const BridgeErrorSchema = z.strictObject({
  code: BridgeErrorCodeSchema,
  message: z.string().min(1).max(2_000),
  traceId: z.uuid(),
  retryable: z.boolean(),
  details: BoundedDetailsSchema.optional(),
});
export type BridgeError = z.infer<typeof BridgeErrorSchema>;

export class SolBridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly traceId: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(error: BridgeError) {
    super(error.message);
    this.name = "SolBridgeError";
    this.code = error.code;
    this.traceId = error.traceId;
    this.retryable = error.retryable;
    this.details = error.details;
  }

  toBridgeError(): BridgeError {
    return BridgeErrorSchema.parse({
      code: this.code,
      message: this.message,
      traceId: this.traceId,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    });
  }
}
