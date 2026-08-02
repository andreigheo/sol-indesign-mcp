import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  validateUxpBundleCode,
  validateUxpCss,
  validateUxpHtml,
  validateUxpManifest,
} from "./lib/uxp-validation.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "apps", "indesign-uxp", "dist");
const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
const code = await readFile(resolve(dist, "main.js"), "utf8");
const html = await readFile(resolve(dist, "index.html"), "utf8");
const css = await readFile(resolve(dist, "styles.css"), "utf8");

validateUxpManifest(manifest);
validateUxpBundleCode(code);
validateUxpHtml(html);
validateUxpCss(css);
process.stdout.write("UXP bundle identity, permissions, entry structure, and execution-surface guards passed.\n");
