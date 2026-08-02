import { describe, expect, it } from "vitest";

import { decodeUtf8, encodeUtf8, utf8ByteLength } from "./utf8.js";

describe("portable UTF-8 primitives", () => {
  it.each(["", "ASCII", "A😀", "Știință 中文", "\ud800x\udfff"])(
    "matches the platform encoder for %j",
    (value) => {
      const expected = new TextEncoder().encode(value);
      expect(encodeUtf8(value)).toEqual(expected);
      expect(utf8ByteLength(value)).toBe(expected.byteLength);
      expect(decodeUtf8(expected)).toBe(new TextDecoder().decode(expected));
    },
  );

  it.each([
    [0x80],
    [0xc0, 0x80],
    [0xe2, 0x82],
    [0xe2, 0x28, 0xa1],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
  ])("rejects malformed input %j", (...bytes) => {
    expect(() => decodeUtf8(Uint8Array.from(bytes))).toThrow(TypeError);
  });
});
