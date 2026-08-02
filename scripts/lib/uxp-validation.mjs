const EXPECTED_DOMAINS = ["http://localhost:32145", "ws://localhost:32145"];
const REQUIRED_ROOT_FILES = ["index.html", "main.js", "manifest.json", "styles.css"];
const MAX_ARCHIVE_ENTRIES = 64;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024;

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.every((item) => typeof item === "string")
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function objectKeysEqual(value, expected) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && sameStrings(Object.keys(value), expected);
}

export function validateUxpManifest(manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("The UXP manifest must be a JSON object.");
  }
  if (manifest.manifestVersion !== 5) throw new Error("The UXP manifest version must be exactly 5.");
  if (manifest.id !== "com.sol.indesign-mcp") throw new Error("The UXP package must use the approved development plugin ID.");
  if (manifest.version !== "0.1.0" || manifest.main !== "index.html") {
    throw new Error("The UXP package version or entry document is unexpected.");
  }
  if (!objectKeysEqual(manifest.host, ["app", "minVersion"])) {
    throw new Error("The UXP host declaration contains unexpected fields.");
  }
  if (manifest.host.app !== "ID" || manifest.host.minVersion !== "18.5.0") {
    throw new Error("The UXP host must be InDesign 18.5.0 or newer.");
  }
  if (!Array.isArray(manifest.entrypoints) || manifest.entrypoints.length !== 1) {
    throw new Error("The development package must expose exactly one entrypoint.");
  }
  const entrypoint = manifest.entrypoints[0];
  if (typeof entrypoint !== "object" || entrypoint === null || entrypoint.type !== "panel" || entrypoint.id !== "sol-indesign-mcp-bridge") {
    throw new Error("The sole UXP entrypoint must be the approved bridge panel.");
  }
  const permissions = manifest.requiredPermissions;
  if (!objectKeysEqual(permissions, ["network", "localFileSystem", "clipboard", "allowCodeGenerationFromStrings"])) {
    throw new Error("The UXP manifest contains missing or unapproved permissions.");
  }
  if (!objectKeysEqual(permissions.network, ["domains"]) || !sameStrings(permissions.network.domains, EXPECTED_DOMAINS)) {
    throw new Error("UXP network permissions must contain only the two approved port-qualified localhost bridge origins.");
  }
  if (permissions.localFileSystem !== "request") throw new Error("UXP localFileSystem permission must be request.");
  if (permissions.clipboard !== "readAndWrite") throw new Error("UXP clipboard permission must be readAndWrite for diagnostics copy.");
  if (permissions.allowCodeGenerationFromStrings !== false) throw new Error("String code generation must be explicitly disabled.");
}

export function validateUxpBundleCode(code) {
  if (typeof code !== "string" || code.length === 0) throw new Error("The UXP JavaScript bundle is empty.");
  const forbiddenPatterns = [
    [/\beval\s*\(/, "direct eval"],
    [/\(\s*0\s*,\s*eval\s*\)\s*\(/, "indirect eval"],
    [/(?:globalThis|window|self)\s*(?:\.\s*eval|\[\s*["']eval["']\s*\])/, "global eval"],
    [/\bnew\s+Function\b|\bFunction\s*\(/, "Function constructor"],
    [/\bchild_process\b|\bshell\s*\.\s*open\b|\blaunchProcess\b/i, "process launch"],
    [/\bVBScript\b|\bExtendScript\b|\bScriptLanguage\s*\.\s*(?:JAVASCRIPT|VISUAL_BASIC)\b/i, "legacy script execution"],
    [/\bprocess\s*\.|\bDeno\s*\.|\bBun\s*\./, "non-UXP runtime surface"],
    [/\bTextEncoder\b|\bTextDecoder\b/, "undocumented TextEncoder/TextDecoder runtime dependency"],
    [/\brequire\s*\(\s*(?!["'](?:uxp|indesign)["']\s*\))/, "unapproved require target"],
  ];
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(code)) throw new Error(`The UXP bundle contains forbidden ${label}.`);
  }
  const approvedLoopbackBases = [
    "ws://localhost:32145/bridge",
    "http://localhost:32145/bridge/http",
  ];
  const loopbackUrls = code.match(/\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[A-Za-z0-9._~!$&()*+,;=:@%/-]*)?/gu) ?? [];
  for (const url of loopbackUrls) {
    const approved = approvedLoopbackBases.some((base) => url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`));
    if (!approved) throw new Error(`The UXP bundle contains an unapproved loopback URL: ${url}.`);
  }
}

export function validateUxpHtml(html) {
  if (typeof html !== "string" || html.length === 0) throw new Error("The UXP HTML entry document is empty.");
  if (/<(?:iframe|webview)\b/i.test(html)) throw new Error("The UXP panel cannot embed iframe or webview content.");
  if (/<form\b/i.test(html)) throw new Error("The UXP panel cannot depend on browser form submission semantics.");
  if (/<label\b[^>]*\bfor\s*=/i.test(html)) throw new Error("The UXP panel cannot use the unsupported label for attribute.");
  if (/<script\b[^>]*\bsrc\s*=\s*["'](?:https?:|\/\/)/i.test(html)) {
    throw new Error("The UXP panel cannot load remote scripts.");
  }
  if (!/<button\b[^>]*\bid\s*=\s*["']pair-token-button["'][^>]*\btype\s*=\s*["']button["'][^>]*>/i.test(html)) {
    throw new Error("The UXP panel must expose a direct-click Pair token button.");
  }
}

export function validateUxpCss(css) {
  if (typeof css !== "string" || css.length === 0) throw new Error("The UXP stylesheet is empty.");
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  if (/\bdisplay\s*:\s*grid\b/iu.test(source) || /\bgrid(?:-[a-z]+)*\s*:/iu.test(source)) {
    throw new Error("The UXP stylesheet cannot use unsupported CSS Grid layout.");
  }
}

export function validateCcxEntries(entries) {
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new Error("The CCX archive entries are invalid.");
  }
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > MAX_ARCHIVE_ENTRIES) throw new Error("The CCX archive entry count is outside the approved bound.");
  if (!sameStrings(names, REQUIRED_ROOT_FILES)) {
    throw new Error("The CCX archive must contain exactly the four approved root files.");
  }
  let totalBytes = 0;
  for (const name of names) {
    if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.endsWith("/")) {
      throw new Error("The CCX archive contains an unsafe or non-file entry path.");
    }
    const segments = name.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new Error("The CCX archive contains an unsafe path segment.");
    }
    const bytes = entries[name];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error("The CCX archive contains an invalid or oversized entry.");
    }
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error("The expanded CCX archive exceeds its size bound.");
  for (const required of REQUIRED_ROOT_FILES) {
    if (!Object.hasOwn(entries, required)) throw new Error(`The CCX archive is missing ${required}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  } catch {
    throw new Error("The packaged UXP manifest is not valid JSON.");
  }
  validateUxpManifest(manifest);
  validateUxpBundleCode(Buffer.from(entries["main.js"]).toString("utf8"));
  validateUxpHtml(Buffer.from(entries["index.html"]).toString("utf8"));
  validateUxpCss(Buffer.from(entries["styles.css"]).toString("utf8"));
  return manifest;
}
