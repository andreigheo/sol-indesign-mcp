import { link, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentWindowsSid,
  inspectCredentialAcl,
  lockCredentialAcl,
  validateCredentialSddl,
  validateSavedAclBytes,
} from "./windows-security.mjs";

const SID = "S-1-5-21-111111111-222222222-333333333-1001";

describe("credential SDDL validation", () => {
  it.each([
    `D:P(A;;FA;;;${SID})`,
    `D:PAI(A;;FA;;;${SID})`,
    `D:PARAI(A;;FA;;;${SID})`,
  ])("accepts a protected sole-user FullControl DACL: %s", (sddl) => {
    expect(validateCredentialSddl(sddl, SID).ok).toBe(true);
  });

  it.each([
    [`D:AI(A;;FA;;;${SID})`, "inheritance"],
    [`D:PAI(A;;FR;;;${SID})`, "exclusive"],
    [`D:PAI(A;;0x1301bf;;;${SID})`, "exclusive"],
    [`D:PAI(D;;FA;;;${SID})`, "exclusive"],
    [`D:PAI(A;ID;FA;;;${SID})`, "exclusive"],
    [`D:PAI(A;OICI;FA;;;${SID})`, "exclusive"],
    [`D:PAI(OA;;FA;01234567-89ab-cdef-0123-456789abcdef;;${SID})`, "exclusive"],
    [`D:PAI(A;;FA;;;${SID})(A;;FR;;;SY)`, "exclusive"],
    ["D:PAI(A;;FA;;;S-1-5-18)", "exclusive"],
    [`D:PX(A;;FA;;;${SID})`, "unsupported"],
    [`O:${SID}D:PAI(A;;FA;;;${SID})`, "malformed"],
    [`D:PAI(A;;FA;;;${SID})S:AI(ML;;NW;;;LW)`, "exclusive"],
  ])("rejects an unsafe or malformed DACL: %s", (sddl, reasonFragment) => {
    const result = validateCredentialSddl(sddl, SID);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(reasonFragment);
  });

  it("requires one bounded UTF-16LE record for the requested file", () => {
    const valid = Buffer.from(`credentials.json\r\nD:PAI(A;;FA;;;${SID})\r\n`, "utf16le");
    expect(validateSavedAclBytes(valid, "credentials.json", SID).ok).toBe(true);
    expect(validateSavedAclBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), valid]), "credentials.json", SID).ok).toBe(true);
    expect(validateSavedAclBytes(valid, "different.json", SID).ok).toBe(false);
    expect(validateSavedAclBytes(Buffer.from("credentials.json\nD:P(A;;FA;;;SID)\n", "utf8"), "credentials.json", SID).ok).toBe(false);
    expect(validateSavedAclBytes(Buffer.concat([valid, Buffer.from([0])]), "credentials.json", SID).ok).toBe(false);
    expect(validateSavedAclBytes(Buffer.from(`credentials.json\r\nD:P(A;;FA;;;${SID})\r\nextra\r\n`, "utf16le"), "credentials.json", SID).ok).toBe(false);
  });
});

const windowsIt = process.platform === "win32" ? it : it.skip;
let temporaryDirectory;
let originalPath;

afterEach(async () => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
  originalPath = undefined;
  temporaryDirectory = undefined;
});

windowsIt("locks and inspects a hard-linked credential without PATH or PowerShell", async () => {
  originalPath = process.env.PATH;
  process.env.PATH = "C:\\not-here";

  temporaryDirectory = await mkdtemp(join(tmpdir(), "sol acl smoke "));
  const temporaryPath = join(temporaryDirectory, ".credential.tmp");
  const publishedPath = join(temporaryDirectory, "credentials.json");
  const handle = await open(temporaryPath, "wx", 0o600);
  await handle.close();

  const sid = currentWindowsSid();
  lockCredentialAcl(temporaryPath, sid);
  expect(inspectCredentialAcl(temporaryPath, sid).ok).toBe(true);

  await link(temporaryPath, publishedPath);
  expect(inspectCredentialAcl(publishedPath, sid).ok).toBe(true);
}, 15_000);
