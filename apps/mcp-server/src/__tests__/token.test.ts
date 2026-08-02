import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeToken, verifyChallengeDigest } from "../token.js";

describe("server authentication token handling", () => {
  it("accepts a canonical 32-byte token", () => {
    const bytes = randomBytes(32);
    expect(decodeToken(bytes.toString("base64url"))).toEqual(bytes);
  });

  it("rejects non-canonical alternate base64url encodings", () => {
    const canonical = Buffer.alloc(32).toString("base64url");
    const nonCanonical = `${canonical.slice(0, -1)}B`;
    expect(() => decodeToken(nonCanonical)).toThrow(/canonical|token|base64url/iu);
  });

  it("verifies only a canonical HMAC-SHA256 digest", () => {
    const token = randomBytes(32);
    const nonce = randomBytes(32).toString("base64url");
    const digest = createHmac("sha256", token).update(nonce, "utf8").digest("base64url");
    expect(verifyChallengeDigest(token, nonce, digest)).toBe(true);
    expect(verifyChallengeDigest(token, nonce, `${digest.slice(0, -1)}B`)).toBe(false);
  });
});
