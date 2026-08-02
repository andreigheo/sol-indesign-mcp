import { describe, expect, it } from "vitest";

import {
  assertWithinSizeLimit,
  byteLength,
  isWithinSizeLimit,
  SizeLimitError,
} from "./size-limit.js";

describe("size limits", () => {
  it("measures UTF-8 bytes rather than UTF-16 code units", () => {
    expect(byteLength("A😀")).toBe(5);
    expect(byteLength(new Uint8Array([1, 2, 3]))).toBe(3);
  });

  it("accepts the exact boundary and rejects one byte over", () => {
    expect(isWithinSizeLimit("1234", 4)).toBe(true);
    expect(isWithinSizeLimit("12345", 4)).toBe(false);
    expect(() => assertWithinSizeLimit("12345", 4)).toThrow(
      SizeLimitError,
    );
  });
});
