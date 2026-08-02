import { describe, expect, it } from "vitest";

import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import {
  decodeSharedToken,
  isValidSharedToken,
  parseSharedToken,
  sharedTokenFromBytes,
  SharedTokenError,
} from "./token.js";

describe("base64url shared tokens", () => {
  it("round-trips arbitrary bytes in canonical unpadded form", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const encoded = encodeBase64Url(bytes);
    expect(encoded).not.toContain("=");
    expect(decodeBase64Url(encoded)).toEqual(bytes);
  });

  it("requires exactly 32 decoded bytes and 43 canonical characters", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const token = sharedTokenFromBytes(bytes);
    expect(token).toHaveLength(43);
    expect(parseSharedToken(token)).toBe(token);
    expect(decodeSharedToken(token)).toEqual(bytes);
    expect(isValidSharedToken(token)).toBe(true);
  });

  it.each([
    "",
    "a".repeat(42),
    "a".repeat(44),
    `${"a".repeat(42)}=`,
    `${"a".repeat(42)}+`,
  ])("rejects malformed token %s", (token) => {
    expect(() => parseSharedToken(token)).toThrow(SharedTokenError);
    expect(isValidSharedToken(token)).toBe(false);
  });

  it("rejects non-canonical trailing bits", () => {
    const valid = sharedTokenFromBytes(new Uint8Array(32));
    const last = valid.at(-1);
    expect(last).toBe("A");
    const nonCanonical = `${valid.slice(0, -1)}B`;
    expect(() => parseSharedToken(nonCanonical)).toThrow(/canonical/u);
  });
});
