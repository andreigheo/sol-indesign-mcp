import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  currentWindowsSid,
  inspectCredentialAcl,
  lockCredentialAcl,
} from "./lib/windows-security.mjs";

if (process.platform !== "win32") {
  throw new Error("setup:token must run with native Windows Node, not WSL Node.");
}

const rotate = process.argv.slice(2).includes("--rotate");
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const credentialPath = join(localAppData, "Sol", "InDesign MCP", "credentials.json");
const credentialDirectory = dirname(credentialPath);
const sid = currentWindowsSid();
await mkdir(credentialDirectory, { recursive: true });

const targetExists = await lstat(credentialPath).then(() => true).catch((error) => {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
  throw error;
});
if (targetExists && !rotate) {
  throw new Error("A pairing token already exists. Use pnpm setup:token -- --rotate to replace it intentionally.");
}

const temporaryPath = join(
  credentialDirectory,
  `.credentials.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
);
const initialHandle = await open(temporaryPath, "wx", 0o600);
await initialHandle.close();

let token;
try {
  // The temporary file is empty until its inherited ACL has been removed.
  lockCredentialAcl(temporaryPath, sid);
  const temporaryAcl = inspectCredentialAcl(temporaryPath, sid);
  if (!temporaryAcl.ok) throw new Error(`Could not verify the temporary credential ACL: ${temporaryAcl.reason}.`);

  token = randomBytes(32).toString("base64url");
  const payload = `${JSON.stringify({ version: 1, token }, null, 2)}\n`;
  const securedHandle = await open(temporaryPath, "r+");
  try {
    await securedHandle.writeFile(payload, "utf8");
    await securedHandle.sync();
  } finally {
    await securedHandle.close();
  }

  if (rotate) {
    await rename(temporaryPath, credentialPath);
  } else {
    // A hard-link publication is atomic and fails closed if another creator won the race.
    await link(temporaryPath, credentialPath);
  }
  const finalAcl = inspectCredentialAcl(credentialPath, sid);
  if (!finalAcl.ok) throw new Error(`Could not verify the published credential ACL: ${finalAcl.reason}.`);
} finally {
  await rm(temporaryPath, { force: true }).catch(() => undefined);
}

process.stdout.write(`Pairing token created at ${credentialPath}.\n`);
process.stdout.write("Paste this token into the Sol InDesign MCP Bridge panel now; it will not be shown by doctor or server logs.\n\n");
process.stdout.write(`${token}\n`);
