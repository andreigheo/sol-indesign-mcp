import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

declare const sharedTokenBrand: unique symbol;

export type SharedToken = string & { readonly [sharedTokenBrand]: true };

export const SHARED_TOKEN_BYTES = 32;
export const SHARED_TOKEN_CHARACTERS = 43;

export class SharedTokenError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "SharedTokenError";
  }
}

export function parseSharedToken(input: string): SharedToken {
  if (input.length !== SHARED_TOKEN_CHARACTERS) {
    throw new SharedTokenError(
      `Shared token must be ${SHARED_TOKEN_CHARACTERS} base64url characters.`,
    );
  }
  try {
    decodeBase64Url(input, SHARED_TOKEN_BYTES);
  } catch (error: unknown) {
    throw new SharedTokenError(
      error instanceof Error ? error.message : "Shared token is invalid.",
    );
  }
  return input as SharedToken;
}

export function isValidSharedToken(input: string): input is SharedToken {
  try {
    parseSharedToken(input);
    return true;
  } catch (error: unknown) {
    if (error instanceof SharedTokenError) {
      return false;
    }
    throw error;
  }
}

export function decodeSharedToken(token: string): Uint8Array {
  return decodeBase64Url(parseSharedToken(token), SHARED_TOKEN_BYTES);
}

export function sharedTokenFromBytes(bytes: Uint8Array): SharedToken {
  if (bytes.byteLength !== SHARED_TOKEN_BYTES) {
    throw new SharedTokenError(
      `Shared token source must contain ${SHARED_TOKEN_BYTES} bytes.`,
    );
  }
  return parseSharedToken(encodeBase64Url(bytes));
}
