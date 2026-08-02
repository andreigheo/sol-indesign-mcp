import { sha256 } from "@noble/hashes/sha2.js";

import { encodeUtf8 } from "./utf8.js";

export class FingerprintError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "FingerprintError";
  }
}

function canonicalize(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) {
        throw new FingerprintError("Fingerprint numbers must be finite.");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new FingerprintError(
        `Unsupported fingerprint value type: ${typeof value}.`,
      );
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw new FingerprintError("Circular fingerprint input is not supported.");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item, nextAncestors)).join(",")}]`;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FingerprintError(
      "Fingerprint objects must be plain objects or arrays.",
    );
  }

  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalize(item, nextAncestors)}`,
    )
    .join(",")}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function fingerprint(value: unknown): string {
  const canonical = canonicalStringify(value);
  const digest = sha256(encodeUtf8(canonical));
  return `sha256:${bytesToHex(digest)}`;
}
