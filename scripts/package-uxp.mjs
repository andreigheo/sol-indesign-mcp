import { spawnSync } from "node:child_process";
import { mkdir, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { validateCcxEntries } from "./lib/uxp-validation.mjs";

const root = resolve(import.meta.dirname, "..");
const appRoot = join(root, "apps", "indesign-uxp");
const dist = join(appRoot, "dist");
const useExistingBuild = process.argv.slice(2).includes("--from-build");
if (!useExistingBuild) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) throw new Error("Run package:uxp through pnpm so the pinned package manager is used.");
  const build = spawnSync(
    process.execPath,
    [npmExecPath, "--filter", "@sol/indesign-uxp...", "build"],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  if (build.status !== 0) throw new Error("The UXP build failed; no package was created.");
}

const collected = new Map();
async function collect(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const absolute = join(directory, name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error("The UXP distribution cannot contain symbolic links.");
    if (info.isDirectory()) {
      await collect(absolute);
    } else if (info.isFile()) {
      const key = relative(dist, absolute).split(sep).join("/");
      collected.set(key, new Uint8Array(await readFile(absolute)));
    } else {
      throw new Error("The UXP distribution contains an unsupported filesystem entry.");
    }
  }
}
await collect(dist);

const entries = Object.fromEntries([...collected.entries()].sort(([left], [right]) => left.localeCompare(right, "en")));
const manifest = validateCcxEntries(entries);
const zipOptions = { level: 9, mtime: new Date("2020-01-01T00:00:00.000Z") };
const archive = zipSync(entries, zipOptions);
const reproducibilityCheck = zipSync(entries, zipOptions);
if (Buffer.compare(Buffer.from(archive), Buffer.from(reproducibilityCheck)) !== 0) {
  throw new Error("The UXP package was not byte-for-byte deterministic within one build.");
}
validateCcxEntries(unzipSync(archive));

const artifactDirectory = join(root, "artifacts");
await mkdir(artifactDirectory, { recursive: true });
const output = join(artifactDirectory, `${manifest.id}-${manifest.version}.ccx`);
await writeFile(output, archive);
const persisted = await readFile(output);
if (Buffer.compare(persisted, Buffer.from(archive)) !== 0) throw new Error("The persisted CCX differs from the validated archive.");
validateCcxEntries(unzipSync(persisted));

process.stdout.write(`Created deterministic development UXP package: ${output}\n`);
process.stdout.write("Distribution still requires an Adobe-issued plugin ID and UXP Developer Tool validation.\n");
