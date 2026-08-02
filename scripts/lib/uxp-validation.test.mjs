import { describe, expect, it } from "vitest";

import {
  validateUxpBundleCode,
  validateUxpCss,
  validateUxpHtml,
  validateUxpManifest,
} from "./uxp-validation.mjs";

const VALID_HTML = '<button id="pair-token-button" type="button">Pair token</button>';
const VALID_MANIFEST = {
  manifestVersion: 5,
  id: "com.sol.indesign-mcp",
  version: "0.1.0",
  main: "index.html",
  host: { app: "ID", minVersion: "18.5.0" },
  entrypoints: [{ type: "panel", id: "sol-indesign-mcp-bridge" }],
  requiredPermissions: {
    network: { domains: ["ws://localhost:32145", "http://localhost:32145"] },
    localFileSystem: "request",
    clipboard: "readAndWrite",
    allowCodeGenerationFromStrings: false,
  },
};

describe("UXP runtime compatibility validation", () => {
  it("accepts the direct-click pairing contract and flex layouts", () => {
    expect(() => validateUxpHtml(VALID_HTML)).not.toThrow();
    expect(() => validateUxpCss(".row { display: flex; flex-wrap: wrap; }")).not.toThrow();
    expect(() => validateUxpBundleCode("const bytes = Uint8Array.from([1]);")).not.toThrow();
  });

  it("requires the UXP-compatible port-qualified localhost permissions", () => {
    expect(() => validateUxpManifest(VALID_MANIFEST)).not.toThrow();
    for (const domains of [
      ["ws://127.0.0.1:32145", "http://127.0.0.1:32145"],
      ["ws://localhost", "http://localhost"],
      ["ws://localhost:32146", "http://localhost:32146"],
      ["ws://localhost:32145/", "http://localhost:32145/"],
      ["ws://localhost:32145/bridge", "http://localhost:32145/bridge/http"],
      ["wss://127.0.0.1", "https://127.0.0.1"],
      ["ws://*", "http://*"],
      ["wss://example.com", "https://example.com"],
      ["ws://localhost:32145", "http://localhost:32145", "https://example.com"],
      "all",
    ]) {
      const invalid = {
        ...VALID_MANIFEST,
        requiredPermissions: {
          ...VALID_MANIFEST.requiredPermissions,
          network: { domains },
        },
      };
      expect(() => validateUxpManifest(invalid)).toThrow(/port-qualified localhost bridge origins/u);
    }
  });

  it.each([
    '<form><button id="pair-token-button" type="button">Pair</button></form>',
    '<label for="token">Token</label><button id="pair-token-button" type="button">Pair</button>',
    '<button id="pair-token-button" type="submit">Pair</button>',
  ])("rejects browser-only pairing markup: %s", (html) => {
    expect(() => validateUxpHtml(html)).toThrow();
  });

  it.each([
    ".row { display: grid; }",
    ".row { grid-template-columns: 1fr 1fr; }",
  ])("rejects unsupported CSS Grid: %s", (css) => {
    expect(() => validateUxpCss(css)).toThrow(/CSS Grid/u);
  });

  it.each([
    "const encoder = new TextEncoder();",
    "const decoder = new TextDecoder();",
  ])("rejects unavailable UXP text codecs: %s", (code) => {
    expect(() => validateUxpBundleCode(code)).toThrow(/TextEncoder\/TextDecoder/u);
  });

  it("allows only the fixed localhost port-32145 bridge URL literals in the UXP bundle", () => {
    expect(() => validateUxpBundleCode(
      'const ws = "ws://localhost:32145/bridge"; const http = "http://localhost:32145/bridge/http";',
    )).not.toThrow();
    for (const code of [
      'fetch("http://127.0.0.1:32145/bridge/http/session")',
      'new WebSocket("ws://localhost:9999/bridge")',
      'new WebSocket("ws://localhost:32145/other")',
      'fetch("http://localhost:32145/health")',
      'fetch("http://127.0.0.1:9999/private")',
    ]) {
      expect(() => validateUxpBundleCode(code)).toThrow(/unapproved loopback URL/u);
    }
  });
});
