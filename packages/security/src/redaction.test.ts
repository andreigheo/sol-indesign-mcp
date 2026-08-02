import { describe, expect, it } from "vitest";

import {
  REDACTED,
  REDACTED_AUTH_FRAME,
  REDACTED_CONTENT,
  redactText,
  redactValue,
} from "./redaction.js";

describe("diagnostic redaction", () => {
  it("redacts bearer tokens, environment assignments, and exact secrets", () => {
    const secret = "sensitive-value";
    const value = redactText(
      `Bearer abc.def SOL_INDESIGN_MCP_TOKEN=token123 exact=${secret}`,
      [secret],
    );
    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("token123");
    expect(value).not.toContain(secret);
    expect(value).toContain(REDACTED);
  });

  it("removes sensitive fields, document text, bytes, and raw stacks", () => {
    const error = new Error("failed with Bearer abc123");
    error.stack = "private stack";
    const redacted = redactValue({
      token: "never-log-me",
      nested: { documentText: "confidential copy", safe: 4 },
      image: new Uint8Array([1, 2, 3]),
      error,
    });
    expect(redacted).toEqual({
      token: REDACTED,
      nested: { documentText: REDACTED_CONTENT, safe: 4 },
      image: REDACTED_CONTENT,
      error: {
        name: "Error",
        message: `failed with Bearer ${REDACTED}`,
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("private stack");
  });

  it("collapses authentication frames", () => {
    expect(
      redactValue({
        type: "BridgeAuthentication",
        sessionId: "session",
        digest: "digest",
      }),
    ).toEqual({
      type: "BridgeAuthentication",
      frame: REDACTED_AUTH_FRAME,
    });
  });

  it("bounds depth and handles circular diagnostic objects", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(redactValue(circular)).toEqual({ self: "[Circular]" });
    expect(redactValue({ a: { b: { c: true } } }, { maxDepth: 2 })).toEqual({
      a: { b: "[MaxDepth]" },
    });
  });
});
