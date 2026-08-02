import { SafeBridgeError } from "../core/errors";

/** Explicit point measurement for DOM fields that otherwise follow ruler preferences. */
export function pointMeasurement(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SafeBridgeError("INVALID_INPUT", "A document measurement must be finite.");
  }
  return `${value} pt`;
}
