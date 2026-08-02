import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { currentWindowsSid, inspectCredentialAcl } from "./lib/windows-security.mjs";

const REQUIRED_NODE_VERSION = "22.22.3";
const root = resolve(import.meta.dirname, "..");
const rows = [];

function result(name, status, detail) {
  rows.push({ name, status, detail });
}

async function exists(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

function isCanonicalToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function isExpectedHealth(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["authenticated", "bridgeConnected", "lastErrorCode", "server", "transport"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return false;
  return value.server === "sol-indesign-mcp"
    && typeof value.bridgeConnected === "boolean"
    && typeof value.authenticated === "boolean"
    && (value.transport === null || value.transport === "websocket" || value.transport === "http")
    && (value.lastErrorCode === null || (typeof value.lastErrorCode === "string" && value.lastErrorCode.length <= 128));
}

result("Windows-native Node", process.platform === "win32" ? "PASS" : "FAIL", `${process.platform} ${process.version}`);
result("Node version", process.versions.node === REQUIRED_NODE_VERSION ? "PASS" : "FAIL", `${process.versions.node}; required ${REQUIRED_NODE_VERSION}`);

const expectedBuilds = [
  "apps/mcp-server/dist/index.js",
  "apps/indesign-uxp/dist/manifest.json",
  "apps/indesign-uxp/dist/main.js",
  "packages/protocol/dist/index.js",
  "packages/domain/dist/index.js",
  "packages/security/dist/index.js",
];
for (const relative of expectedBuilds) {
  result(`Build ${relative}`, await exists(join(root, relative)) ? "PASS" : "FAIL", relative);
}

const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const credentialPath = join(localAppData, "Sol", "InDesign MCP", "credentials.json");
const credentialExists = await exists(credentialPath);
const environmentToken = process.env.SOL_INDESIGN_MCP_TOKEN;
const environmentConfigured = typeof environmentToken === "string" && environmentToken.length > 0;
if (environmentConfigured) {
  const valid = isCanonicalToken(environmentToken);
  result("Pairing token", valid ? "PASS" : "FAIL", valid ? "valid environment override" : "environment override is invalid; credential file fallback is disabled");
} else if (credentialExists) {
  try {
    const parsed = JSON.parse(await readFile(credentialPath, "utf8"));
    const valid = typeof parsed === "object"
      && parsed !== null
      && parsed.version === 1
      && isCanonicalToken(parsed.token);
    result("Pairing token", valid ? "PASS" : "FAIL", valid ? "credential file contains a canonical 32-byte token" : "credential file is malformed");
  } catch {
    result("Pairing token", "FAIL", "credential file cannot be parsed");
  }
} else {
  result("Pairing token", "FAIL", "not configured; run pnpm setup:token");
}

if (credentialExists && process.platform === "win32") {
  try {
    const sid = currentWindowsSid();
    const acl = inspectCredentialAcl(credentialPath, sid);
    result("Credential ACL", acl.ok ? "PASS" : "FAIL", acl.reason);
  } catch {
    result("Credential ACL", "FAIL", "current-user ACL inspection failed");
  }
} else if (credentialExists) {
  result("Credential ACL", "FAIL", "must be inspected with native Windows Node");
} else {
  result("Credential ACL", "WARN", environmentConfigured ? "not applicable to the environment override" : "credential file is absent");
}

let health;
let localhostHealth;
try {
  const response = await fetch("http://127.0.0.1:32145/health", { signal: AbortSignal.timeout(750) });
  if (response.ok) health = await response.json();
} catch { /* server may be stopped */ }
try {
  const response = await fetch("http://localhost:32145/health", { signal: AbortSignal.timeout(750) });
  if (response.ok) localhostHealth = await response.json();
} catch { /* server may be stopped or localhost may not reach the IPv4 listener */ }
if (isExpectedHealth(health)) {
  result("Port 32145", "PASS", "Sol InDesign MCP bridge server is listening");
  result(
    "UXP localhost route",
    isExpectedHealth(localhostHealth) ? "PASS" : "FAIL",
    isExpectedHealth(localhostHealth) ? "localhost reaches the IPv4-only bridge" : "localhost cannot reach the IPv4-only bridge",
  );
  result("Bridge status", health.authenticated ? "PASS" : "WARN", health.authenticated ? "plugin authenticated" : "server running; plugin not authenticated");
} else {
  const canBind = await new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", () => resolveBind(false));
    server.listen(32145, "127.0.0.1", () => server.close(() => resolveBind(true)));
  });
  if (health !== undefined) {
    result("Port 32145", "FAIL", "occupied by a process that does not expose the exact Sol bridge health identity");
  } else {
    result("Port 32145", canBind ? "PASS" : "FAIL", canBind ? "available" : "occupied by an unknown process");
  }
  result("UXP localhost route", "WARN", "not testable while the bridge server is stopped");
  result("Bridge status", "WARN", "Sol InDesign MCP server is not available");
}

const inDesign = "C:\\Program Files\\Adobe\\Adobe InDesign 2026\\InDesign.exe";
const inDesignFound = await exists(inDesign);
result("Adobe InDesign", inDesignFound ? "PASS" : "WARN", inDesignFound ? "stable 2026 installation found" : "not found at the expected stable path");
const udtCandidates = [
  "C:\\Program Files\\Adobe\\Adobe UXP Developer Tools\\Adobe UXP Developer Tools.exe",
  "C:\\Program Files\\Adobe\\UXP Developer Tool\\UXP Developer Tool.exe",
  join(localAppData, "Programs", "Adobe", "Adobe UXP Developer Tools", "Adobe UXP Developer Tools.exe"),
  join(localAppData, "Programs", "Adobe", "UXP Developer Tool", "UXP Developer Tool.exe"),
];
let udtFound = false;
for (const candidate of udtCandidates) if (await exists(candidate)) udtFound = true;
result("UXP Developer Tool", udtFound ? "PASS" : "WARN", udtFound ? "installed" : "not found; required for real-host smoke testing");

for (const row of rows) process.stdout.write(`${row.status.padEnd(5)} ${row.name}: ${row.detail}\n`);
const failures = rows.filter((row) => row.status === "FAIL").length;
process.stdout.write(`\n${failures === 0 ? "Doctor checks completed without failures." : `${failures} required check(s) failed.`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
