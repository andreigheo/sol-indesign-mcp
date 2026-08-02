export type BridgeErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "BRIDGE_PROTOCOL_ERROR"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "DOCUMENT_MISMATCH"
  | "DOCUMENT_NOT_FOUND"
  | "FILE_EXISTS"
  | "FILE_NOT_FOUND"
  | "FONT_NOT_FOUND"
  | "INVALID_INPUT"
  | "ITEM_NOT_FOUND"
  | "PATH_NOT_ALLOWED"
  | "PARTIAL_FAILURE"
  | "STALE_DOCUMENT"
  | "STALE_OBJECT"
  | "STYLE_NOT_FOUND"
  | "PRESET_NOT_FOUND"
  | "UNSUPPORTED_CAPABILITY"
  | "UXP_OPERATION_FAILED"
  | "WORKSPACE_REQUIRED";

export interface SafeErrorShape {
  code: BridgeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class SafeBridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: BridgeErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "SafeBridgeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toSafeShape(): SafeErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function toSafeError(error: unknown): SafeBridgeError {
  if (error instanceof SafeBridgeError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new SafeBridgeError("CANCELLED", "The request was cancelled before it started.", { retryable: true });
  }
  return new SafeBridgeError(
    "UXP_OPERATION_FAILED",
    "InDesign could not complete the requested operation.",
    { retryable: false },
  );
}
