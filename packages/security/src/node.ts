import {
  createHmac,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import {
  assertChallengeNonce,
  HMAC_SHA256_BYTES,
} from "./hmac.js";
import {
  decodeSharedToken,
  sharedTokenFromBytes,
  type SharedToken,
} from "./token.js";

export function generateSharedToken(): SharedToken {
  return sharedTokenFromBytes(randomBytes(32));
}

export function computeChallengeDigestNode(
  token: string,
  nonce: string,
): string {
  assertChallengeNonce(nonce);
  const digest = createHmac("sha256", decodeSharedToken(token))
    .update(nonce, "utf8")
    .digest();
  return encodeBase64Url(digest);
}

export function timingSafeEqualBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return nodeTimingSafeEqual(left, right);
}

export function timingSafeEqualBase64Url(
  left: string,
  right: string,
  expectedBytes?: number,
): boolean {
  try {
    return timingSafeEqualBytes(
      decodeBase64Url(left, expectedBytes),
      decodeBase64Url(right, expectedBytes),
    );
  } catch {
    return false;
  }
}

export function verifyChallengeDigestNode(
  token: string,
  nonce: string,
  candidateDigest: string,
): boolean {
  try {
    const expected = computeChallengeDigestNode(token, nonce);
    return timingSafeEqualBase64Url(
      expected,
      candidateDigest,
      HMAC_SHA256_BYTES,
    );
  } catch {
    return false;
  }
}
