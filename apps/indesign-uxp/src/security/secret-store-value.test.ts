import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "@sol/security/uxp";
import { decodeStoredToken } from "./secret-store-value";

describe("UXP secure-storage token decoding", () => {
  it("accepts the documented Uint8Array result", () => {
    expect(decodeStoredToken(encodeUtf8("token-value"))).toBe("token-value");
  });

  it("accepts guarded host-compatible string and ArrayBuffer values", () => {
    expect(decodeStoredToken("token-value")).toBe("token-value");
    const bytes = encodeUtf8("token-value");
    expect(decodeStoredToken(bytes.buffer)).toBe("token-value");
  });

  it.each([false, null, undefined, 42, { value: "token-value" }])(
    "rejects an unsupported runtime value: %j",
    (value) => {
      expect(() => decodeStoredToken(value)).toThrow(TypeError);
    },
  );
});
