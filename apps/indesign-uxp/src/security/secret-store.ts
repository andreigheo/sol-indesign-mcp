import { encodeUtf8, parseSharedToken } from "@sol/security/uxp";
import { storage } from "uxp";
import { SafeBridgeError } from "../core/errors";
import { decodeStoredToken } from "./secret-store-value";

const TOKEN_KEY = "sol.indesign-mcp.shared-token.v1";
export class SecretStore {
  #cachedToken: string | undefined;

  async hasToken(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async getToken(): Promise<string | undefined> {
    if (this.#cachedToken !== undefined) return this.#cachedToken;
    let stored: unknown;
    try {
      stored = await storage.secureStorage.getItem(TOKEN_KEY);
    } catch (error: unknown) {
      // InDesign UXP rejects a missing secure-storage key with the value false.
      if (error === false) return undefined;
      throw new SafeBridgeError("AUTHENTICATION_FAILED", "UXP secure storage could not read the paired token. Pair it again.");
    }
    if (stored === null || stored === undefined || stored === false) return undefined;
    let token: string;
    try {
      token = decodeStoredToken(stored);
    } catch {
      await this.#removeInvalidToken();
      throw new SafeBridgeError("AUTHENTICATION_FAILED", "The paired token is unreadable. Pair it again.");
    }
    try {
      parseSharedToken(token);
    } catch {
      await this.#removeInvalidToken();
      throw new SafeBridgeError("AUTHENTICATION_FAILED", "The paired token is invalid. Pair it again.");
    }
    this.#cachedToken = token;
    return token;
  }

  async setToken(tokenInput: string): Promise<void> {
    const token = tokenInput.trim();
    try {
      parseSharedToken(token);
    } catch {
      throw new SafeBridgeError("INVALID_INPUT", "The pairing token must be a 32-byte base64url value (43 characters).", { retryable: false });
    }
    try {
      await storage.secureStorage.setItem(TOKEN_KEY, encodeUtf8(token));
    } catch {
      throw new SafeBridgeError("AUTHENTICATION_FAILED", "UXP secure storage could not store the pairing token. Pair it again.");
    }
    this.#cachedToken = token;
  }

  async clearToken(): Promise<void> {
    this.#cachedToken = undefined;
    try {
      await storage.secureStorage.removeItem(TOKEN_KEY);
    } catch (error: unknown) {
      if (error !== false) {
        throw new SafeBridgeError("AUTHENTICATION_FAILED", "UXP secure storage could not clear the paired token.");
      }
    }
  }

  async #removeInvalidToken(): Promise<void> {
    try {
      await this.clearToken();
    } catch {
      // Preserve the more actionable unreadable/invalid-token error.
    }
  }
}
