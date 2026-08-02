import { describe, expect, it } from "vitest";
import { encodeStandardBase64 } from "./base64";

describe("MCP image base64", () => {
  it("uses the standard alphabet and retains padding", () => {
    expect(encodeStandardBase64(Uint8Array.of(0xff, 0xee, 0xdd))).toBe("/+7d");
    expect(encodeStandardBase64(Uint8Array.of(0x66))).toBe("Zg==");
  });
});
