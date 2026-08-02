import { utf8ByteLength } from "./utf8.js";

export const MAX_BRIDGE_FRAME_BYTES = 8 * 1024 * 1024;

export type SizeMeasurable = string | Uint8Array | ArrayBuffer;

export class SizeLimitError extends RangeError {
  readonly actualBytes: number;
  readonly limitBytes: number;

  constructor(actualBytes: number, limitBytes: number) {
    super(`Payload is ${actualBytes} bytes; the limit is ${limitBytes} bytes.`);
    this.name = "SizeLimitError";
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

export function byteLength(value: SizeMeasurable): number {
  if (typeof value === "string") {
    return utf8ByteLength(value);
  }
  return value.byteLength;
}

export function isWithinSizeLimit(
  value: SizeMeasurable,
  limitBytes = MAX_BRIDGE_FRAME_BYTES,
): boolean {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new RangeError("Size limit must be a non-negative safe integer.");
  }
  return byteLength(value) <= limitBytes;
}

export function assertWithinSizeLimit(
  value: SizeMeasurable,
  limitBytes = MAX_BRIDGE_FRAME_BYTES,
): void {
  const actualBytes = byteLength(value);
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new RangeError("Size limit must be a non-negative safe integer.");
  }
  if (actualBytes > limitBytes) {
    throw new SizeLimitError(actualBytes, limitBytes);
  }
}
