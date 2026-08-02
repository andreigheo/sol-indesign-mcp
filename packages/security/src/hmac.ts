import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { decodeSharedToken } from "./token.js";
import { encodeUtf8 } from "./utf8.js";

export const CHALLENGE_NONCE_BYTES = 32;
export const HMAC_SHA256_BYTES = 32;

function messageBytes(message: string | Uint8Array): Uint8Array {
  return typeof message === "string"
    ? encodeUtf8(message)
    : new Uint8Array(message);
}

export function hmacSha256(
  key: Uint8Array,
  message: string | Uint8Array,
): Uint8Array {
  return hmac(sha256, key, messageBytes(message));
}

export function hmacSha256Base64Url(
  key: Uint8Array,
  message: string | Uint8Array,
): string {
  return encodeBase64Url(hmacSha256(key, message));
}

export function assertChallengeNonce(nonce: string): void {
  decodeBase64Url(nonce, CHALLENGE_NONCE_BYTES);
}

/** HMAC message bytes are the UTF-8 bytes of the canonical nonce string. */
export function computeChallengeDigest(token: string, nonce: string): string {
  assertChallengeNonce(nonce);
  return hmacSha256Base64Url(decodeSharedToken(token), nonce);
}

export function constantTimeEqualBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function constantTimeEqualBase64Url(
  left: string,
  right: string,
  expectedBytes?: number,
): boolean {
  try {
    return constantTimeEqualBytes(
      decodeBase64Url(left, expectedBytes),
      decodeBase64Url(right, expectedBytes),
    );
  } catch {
    return false;
  }
}
