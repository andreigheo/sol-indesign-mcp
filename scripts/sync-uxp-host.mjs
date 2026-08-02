import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { validateCcxEntries } from "./lib/uxp-validation.mjs";

const REQUIRED_FILES = ["index.html", "main.js", "manifest.json", "styles.css"];
const PLUGIN_ID = "com.sol.indesign-mcp";
const PLUGIN_VERSION = "0.1.0";

if (process.platform !== "win32") {
  throw new Error("sync:uxp-host must run with native Windows Node.");
}
const appData = process.env.APPDATA;
if (appData === undefined || appData.length === 0) throw new Error("APPDATA is unavailable.");

const root = resolve(import.meta.dirname, "..");
const sourceManifestPath = join(root, "apps", "indesign-uxp", "manifest.json");
const distDirectory = join(root, "apps", "indesign-uxp", "dist");
const externalDirectory = join(appData, "Adobe", "UXP", "Plugins", "External", `${PLUGIN_ID}_${PLUGIN_VERSION}`);
const pluginsInfoPath = join(appData, "Adobe", "UXP", "PluginsInfo", "v1", "ID.json");
const packagePath = join(root, "artifacts", `${PLUGIN_ID}-${PLUGIN_VERSION}.ccx`);

const sourceManifest = await readFile(sourceManifestPath);
const distEntries = {};
for (const name of REQUIRED_FILES) distEntries[name] = new Uint8Array(await readFile(join(distDirectory, name)));
validateCcxEntries(distEntries);
assertEqual(sourceManifest, distEntries["manifest.json"], "source and built manifests");

const distNames = (await readdir(distDirectory)).sort();
if (JSON.stringify(distNames) !== JSON.stringify(REQUIRED_FILES)) {
  throw new Error("The UXP distribution must contain exactly the four approved files.");
}

const packageEntries = unzipSync(new Uint8Array(await readFile(packagePath)));
validateCcxEntries(packageEntries);
for (const name of REQUIRED_FILES) assertEqual(distEntries[name], packageEntries[name], `built and packaged ${name}`);

assertPluginsInfo(await readFile(pluginsInfoPath, "utf8"));
await mkdir(externalDirectory, { recursive: true });
for (const name of REQUIRED_FILES) await writeDurably(join(externalDirectory, name), distEntries[name]);

const externalNames = (await readdir(externalDirectory)).sort();
if (JSON.stringify(externalNames) !== JSON.stringify(REQUIRED_FILES)) {
  throw new Error("The installed External UXP bundle contains unexpected files.");
}
for (const name of REQUIRED_FILES) {
  assertEqual(distEntries[name], new Uint8Array(await readFile(join(externalDirectory, name))), `built and installed ${name}`);
}

const manifestHash = digest(distEntries["manifest.json"]);
const bundleHash = digest(distEntries["main.js"]);
const packageHash = digest(new Uint8Array(await readFile(packagePath)));
process.stdout.write(`UXP host sync verified: manifest=${manifestHash} bundle=${bundleHash} package=${packageHash}\n`);
process.stdout.write("Source, dist, canonical CCX, and External bundle are byte-for-byte consistent.\n");

async function writeDurably(path, bytes) {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertEqual(left, right, label) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || Buffer.compare(Buffer.from(left), Buffer.from(right)) !== 0) {
    throw new Error(`Mismatch between ${label}.`);
  }
}

function assertPluginsInfo(source) {
  let decoded;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error("The InDesign UXP plugin registry is not valid JSON.");
  }
  if (typeof decoded !== "object" || decoded === null || !Array.isArray(decoded.plugins)) {
    throw new Error("The InDesign UXP plugin registry has an unsupported shape.");
  }
  const matches = decoded.plugins.filter((plugin) => (
    typeof plugin === "object"
    && plugin !== null
    && plugin.pluginId === PLUGIN_ID
    && plugin.versionString === PLUGIN_VERSION
    && plugin.path === `$localPlugins\\External\\${PLUGIN_ID}_${PLUGIN_VERSION}`
    && plugin.status === "enabled"
  ));
  if (matches.length !== 1) throw new Error("The canonical External InDesign UXP registration is missing or ambiguous.");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
