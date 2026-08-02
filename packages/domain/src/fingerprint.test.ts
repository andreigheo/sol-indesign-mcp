import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  fingerprint,
  FingerprintError,
} from "./fingerprint.js";

describe("deterministic fingerprints", () => {
  it("sorts object keys recursively", () => {
    const left = { z: 1, nested: { b: true, a: [2, "x"] } };
    const right = { nested: { a: [2, "x"], b: true }, z: 1 };
    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
    expect(fingerprint(left)).toBe(fingerprint(right));
    expect(fingerprint(left)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("changes when a fingerprinted property changes", () => {
    expect(fingerprint({ width: 10 })).not.toBe(fingerprint({ width: 11 }));
  });

  it("rejects ambiguous and circular values", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => fingerprint({ value: undefined })).toThrow(
      FingerprintError,
    );
    expect(() => fingerprint(circular)).toThrow(/Circular/u);
    expect(() => fingerprint(Number.NaN)).toThrow(/finite/u);
  });
});
