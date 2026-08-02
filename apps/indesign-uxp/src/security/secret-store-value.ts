import { decodeUtf8 } from "@sol/security/uxp";

export function decodeStoredToken(stored: unknown): string {
  if (typeof stored === "string") return stored;
  if (stored instanceof Uint8Array) return decodeUtf8(stored);
  if (stored instanceof ArrayBuffer) return decodeUtf8(new Uint8Array(stored));
  throw new TypeError("The secure-storage value has an unsupported type.");
}
