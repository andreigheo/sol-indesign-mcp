import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL(".", import.meta.url);
const rootPath = fileURLToPath(root);
const dist = new URL("./dist/", root);
const cleanOnly = process.argv.includes("--clean");
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
if (cleanOnly) process.exit(0);
await mkdir(dist, { recursive: true });

const copyStatic = async () => {
  await Promise.all([
    cp(new URL("./src/index.html", root), new URL("./index.html", dist)),
    cp(new URL("./src/styles.css", root), new URL("./styles.css", dist)),
    cp(new URL("./manifest.json", root), new URL("./manifest.json", dist))
  ]);
  const manifestPath = new URL("./manifest.json", dist);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sourcePackage = JSON.parse(await readFile(new URL("./package.json", root), "utf8"));
  manifest.version = sourcePackage.version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

await copyStatic();

const options = {
  entryPoints: [resolve(rootPath, "src/main.ts")],
  outfile: fileURLToPath(new URL("./main.js", dist)),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2020",
  external: ["uxp", "indesign"],
  sourcemap: false,
  legalComments: "none",
  charset: "utf8",
  define: {
    __SOL_PLUGIN_VERSION__: JSON.stringify("0.1.0")
  },
  logLevel: "info"
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.error("Sol InDesign MCP UXP build is watching for changes.");
} else {
  await build(options);
}
