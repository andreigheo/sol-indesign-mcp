import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_SAVED_ACL_BYTES = 64 * 1024;
const SID_PATTERN = /^S-[0-9]+(?:-[0-9]+)+$/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function windowsExecutable(name) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!nonEmpty(systemRoot) || !win32.isAbsolute(systemRoot)) {
    throw new Error("The Windows system directory is unavailable for credential ACL enforcement.");
  }
  return win32.join(systemRoot, "System32", name);
}

function isValidSid(sid) {
  return typeof sid === "string" && sid.length <= 184 && SID_PATTERN.test(sid);
}

function failed(reason) {
  return { ok: false, reason };
}

function succeeded() {
  return { ok: true, reason: "inheritance disabled; current user SID is the sole FullControl identity" };
}

function commandSucceeded(result) {
  return result.error === undefined && result.signal === null && result.status === 0;
}

export function currentWindowsSid() {
  const result = spawnSync(
    windowsExecutable("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    {
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (!commandSucceeded(result) || !Buffer.isBuffer(result.stdout) || result.stdout.byteLength > 4_096) {
    throw new Error("Could not determine the current Windows SID for credential ACL enforcement.");
  }
  const output = result.stdout.toString("latin1");
  const match = /^"(?:""|[^"\r\n])*","(S-[0-9]+(?:-[0-9]+)+)"\r?\n?$/u.exec(output);
  const sid = match?.[1];
  if (!isValidSid(sid)) {
    throw new Error("The current Windows SID response is malformed.");
  }
  return sid;
}

export function lockCredentialAcl(path, sid) {
  if (!isValidSid(sid)) {
    throw new Error("A valid current-user SID is required for credential ACL enforcement.");
  }
  const result = spawnSync(
    windowsExecutable("icacls.exe"),
    [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
    {
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (!commandSucceeded(result)) {
    throw new Error("Could not restrict the credential file to the current Windows SID.");
  }
}

function parseDaclControlFlags(value) {
  const flags = new Set();
  let offset = 0;
  while (offset < value.length) {
    let flag;
    if (value.startsWith("AI", offset)) flag = "AI";
    else if (value.startsWith("AR", offset)) flag = "AR";
    else if (value.startsWith("P", offset)) flag = "P";
    else return undefined;
    if (flags.has(flag)) return undefined;
    flags.add(flag);
    offset += flag.length;
  }
  return flags;
}

export function validateCredentialSddl(sddl, sid) {
  if (typeof sddl !== "string" || !isValidSid(sid) || !sddl.startsWith("D:")) {
    return failed("saved credential DACL is malformed");
  }
  const firstAce = sddl.indexOf("(");
  if (firstAce < 2) return failed("saved credential DACL is malformed");
  const flags = parseDaclControlFlags(sddl.slice(2, firstAce));
  if (flags === undefined) return failed("saved credential DACL has unsupported control flags");
  if (!flags.has("P")) return failed("credential ACL inheritance is not disabled");
  if (sddl.slice(firstAce) !== `(A;;FA;;;${sid})`) {
    return failed("credential DACL is not an exclusive current-user FullControl grant");
  }
  return succeeded();
}

export function validateSavedAclBytes(bytes, expectedBasename, sid) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength === 0
    || bytes.byteLength > MAX_SAVED_ACL_BYTES
    || bytes.byteLength % 2 !== 0
    || !nonEmpty(expectedBasename)
  ) {
    return failed("saved credential DACL response is malformed");
  }
  const decoded = bytes.toString("utf16le").replace(/^\uFEFF/u, "");
  if (decoded.includes("\u0000")) return failed("saved credential DACL response is malformed");
  const match = /^([^\r\n]+)\r\n([^\r\n]+)\r\n$/u.exec(decoded);
  if (match === null) return failed("saved credential DACL response is malformed");
  const savedBasename = match[1];
  const sddl = match[2];
  if (
    savedBasename === undefined
    || sddl === undefined
    || savedBasename.toLocaleLowerCase("en-US") !== expectedBasename.toLocaleLowerCase("en-US")
  ) {
    return failed("saved credential DACL does not identify the requested file");
  }
  return validateCredentialSddl(sddl, sid);
}

export function inspectCredentialAcl(path, sid) {
  if (!isValidSid(sid)) return failed("a valid current-user SID is required for ACL inspection");

  let before;
  try {
    before = lstatSync(path);
  } catch {
    return failed("credential file is unavailable for ACL inspection");
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return failed("credential ACL target is not a regular file");
  }

  let inspectionDirectory;
  let outcome;
  try {
    inspectionDirectory = mkdtempSync(win32.join(tmpdir(), "sol-indesign-acl-"));
    const savedAclPath = win32.join(inspectionDirectory, "saved-acl.txt");
    const savedAclHandle = openSync(savedAclPath, "wx", 0o600);
    closeSync(savedAclHandle);
    lockCredentialAcl(savedAclPath, sid);

    const result = spawnSync(
      windowsExecutable("icacls.exe"),
      [path, "/save", savedAclPath, "/q"],
      {
        encoding: "utf8",
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    if (!commandSucceeded(result)) {
      outcome = failed("credential DACL inspection failed due to Windows policy or file access");
    } else {
      const after = lstatSync(path);
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
        outcome = failed("credential ACL target changed during inspection");
      } else {
        const savedAcl = readFileSync(savedAclPath);
        outcome = validateSavedAclBytes(savedAcl, win32.basename(path), sid);
      }
    }
  } catch {
    outcome = failed("credential DACL inspection could not be completed safely");
  } finally {
    if (inspectionDirectory !== undefined) {
      try {
        rmSync(inspectionDirectory, { force: true, recursive: true });
      } catch {
        outcome = failed("credential DACL inspection cleanup failed");
      }
    }
  }
  return outcome ?? failed("credential DACL inspection did not produce a result");
}
