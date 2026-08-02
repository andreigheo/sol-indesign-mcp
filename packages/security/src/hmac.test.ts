import { describe, expect, it } from "vitest";

import { encodeBase64Url } from "./base64url.js";
import {
  computeChallengeDigest,
  constantTimeEqualBase64Url,
  constantTimeEqualBytes,
  hmacSha256,
} from "./hmac.js";
import {
  computeChallengeDigestNode,
  generateSharedToken,
  timingSafeEqualBase64Url,
  verifyChallengeDigestNode,
} from "./node.js";
import { sharedTokenFromBytes } from "./token.js";

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("HMAC authentication helpers", () => {
  it("matches RFC 4231 HMAC-SHA256 test case 1", () => {
    const key = new Uint8Array(20).fill(0x0b);
    const digest = hmacSha256(key, "Hi There");
    expect(toHex(digest)).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("produces identical portable and Node challenge digests", () => {
    const token = sharedTokenFromBytes(
      Uint8Array.from({ length: 32 }, (_, index) => index),
    );
    const nonce = encodeBase64Url(
      Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
    );
    const portable = computeChallengeDigest(token, nonce);
    const node = computeChallengeDigestNode(token, nonce);
    expect(portable).toBe(node);
    expect(verifyChallengeDigestNode(token, nonce, portable)).toBe(true);
    expect(
      verifyChallengeDigestNode(token, nonce, `${portable.slice(0, -1)}A`),
    ).toBe(false);
  });

  it("wraps timing-safe comparisons and fails closed on malformed input", () => {
    expect(
      constantTimeEqualBytes(
        new Uint8Array([1, 2]),
        new Uint8Array([1, 2]),
      ),
    ).toBe(true);
    expect(
      constantTimeEqualBytes(new Uint8Array([1]), new Uint8Array([1, 0])),
    ).toBe(false);
    expect(constantTimeEqualBase64Url("invalid+", "invalid+")).toBe(false);
    expect(timingSafeEqualBase64Url("invalid+", "invalid+")).toBe(false);
  });

  it("generates canonical 32-byte Node tokens", () => {
    const first = generateSharedToken();
    const second = generateSharedToken();
    expect(first).toHaveLength(43);
    expect(first).not.toBe(second);
  });
});
