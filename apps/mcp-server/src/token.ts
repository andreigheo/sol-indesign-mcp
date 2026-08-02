import { readFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeBase64Url, decodeSharedToken } from "@sol/security";
import type { ServerConfig } from "./config.js";

export function decodeToken(token: string): Buffer {
  return Buffer.from(decodeSharedToken(token));
}

export async function loadSharedToken(config: ServerConfig): Promise<Buffer> {
  const environmentToken = process.env.SOL_INDESIGN_MCP_TOKEN;
  if (environmentToken !== undefined && environmentToken.length > 0) {
    return decodeToken(environmentToken);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(config.credentialPath, "utf8")) as unknown;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown read failure";
    throw new Error(`Pairing token is unavailable. Run pnpm setup:token. (${reason})`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || !("token" in parsed) || typeof parsed.token !== "string") {
    throw new Error("The LocalAppData credential file is malformed.");
  }
  return decodeToken(parsed.token);
}

export function createChallengeDigest(token: Uint8Array, nonce: string): Buffer {
  return createHmac("sha256", token).update(nonce, "utf8").digest();
}

export function verifyChallengeDigest(token: Uint8Array, nonce: string, digest: string): boolean {
  let actual: Buffer;
  try {
    actual = Buffer.from(decodeBase64Url(digest, 32));
  } catch {
    return false;
  }
  const expected = createChallengeDigest(token, nonce);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
