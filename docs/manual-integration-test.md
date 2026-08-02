# Real InDesign integration smoke test

This is the required release-readiness test for `sol-indesign-mcp`. It exercises the built UXP plugin inside stable Adobe InDesign through the real Codex STDIO server and authenticated loopback bridge.

> **Current status (2026-07-16): every functional surface has real-host evidence; the formal immutable release record remains open.** UDT 2.2.1.2 loaded the final development build in stable InDesign 21.4.1 / UXP 9.3. The installed-host runs passed all eleven tools, all sixteen operation variants, preview, save-copy, PDF/PNG/JPEG/IDML, security failures, preflight, exact grouping membership, grouped-child reference resolution, and the required human-observed one-step Undo. See [the current evidence](real-host-validation-2026-07-16.md). Distribution still requires an Adobe-issued plugin ID and a clean record tied to an immutable commit.

## Test policy

- Run Node, pnpm, Codex, UDT, and InDesign as native Windows processes. Do not run the server in WSL.
- Use stable InDesign, not beta 21.5.
- Use a new empty test workspace containing no valuable files.
- Never paste the pairing token into this record, logs, screenshots, or a prompt.
- Keep UDT's plugin console and the MCP server's redacted stderr/audit logs available.
- Stop on an authentication, schema, containment, wrong-document, partial-mutation, preference-restoration, or stdout-contamination failure. Preserve redacted evidence before retrying.
- Record the tool trace ID and safe result/error code for every Codex tool call.
- `overwrite` must remain false throughout this smoke test. Delete old smoke outputs manually before starting rather than approving replacement.

## Environment record

Fill this in before testing:

```text
Date/time and timezone:
Tester:
Git commit:
Windows version:
Node version (must be v22.22.3 win32):
pnpm version (must be 11.13.0):
InDesign version/build:
UXP runtime version, if shown:
UXP Developer Tool version:
Plugin version:
Bridge protocol version:
Primary/fallback transport observed:
Workspace path (do not include private user content):
PDF preset selected for step 12:
```

Prepare an empty workspace with these subdirectories, or allow the plugin to create permitted output segments if implemented:

```text
previews/
copies/
exports/
```

Ensure these files do not exist before the run:

```text
previews/sol-smoke.png
copies/sol-smoke.indd
exports/sol-smoke.pdf
```

## 1. Build the repository

Open native Windows PowerShell in the repository root and run:

```powershell
where.exe node
node -p "process.platform + ' ' + process.version"
corepack enable
corepack prepare pnpm@11.13.0 --activate
pnpm install
pnpm clean
pnpm verify
pnpm sync:uxp-host
```

Pass criteria:

- Node reports `win32 v22.22.3`.
- Install, clean, verification, packaging, and host synchronization exit with code 0.
- `pnpm verify` runs lint, strict typecheck, unit tests, contract/mock end-to-end tests, builds, and artifact smoke checks.
- The UXP build contains `apps\indesign-uxp\dist\manifest.json` and its bundle.
- The deterministic development CCX exists and package validation passes.
- `pnpm sync:uxp-host` reports byte-for-byte agreement among the source manifest, four-file dist bundle, canonical CCX, and registered External bundle.
- No non-MCP operational text is emitted by the server's stdout-purity test.

Save the command transcript without environment-variable values or credentials.

## 2. Load the UXP plugin through UXP Developer Tool

Install UDT through the supported Adobe distribution channel if it is not present. Start stable InDesign and UDT under the same Windows user.

In UDT:

- add a plugin by selecting `apps\indesign-uxp\dist\manifest.json`;
- choose the stable InDesign instance;
- fully unload any prior instance, then load the plugin so manifest permissions are registered afresh;
- open the plugin console and retain a screenshot or redacted transcript.

Pass criteria:

- UDT accepts manifest version 5 and host `ID` with minimum version 18.5.0;
- the manifest contains exactly `ws://localhost:32145` and `http://localhost:32145`, the trusted plugin uses only those fixed origins/paths, and the server remains bound only to `127.0.0.1:32145`;
- InDesign loads the plugin ID `com.sol.indesign-mcp` without a manifest or syntax error;
- the console contains no `eval`, `new Function`, unapproved permission, missing-module, or startup exception;
- no beta InDesign instance is used.

ADR 0005 permits only `ws://localhost:32145` and `http://localhost:32145` because UXP 9.3 discards IP-literal manifest domains. The Node listener must still bind only to `127.0.0.1:32145`. If UDT rejects these declarations or a host API, record the exact runtime/version and safe error; do not omit/change the port, add path selectors, wildcards, external domains, `all`, or broader filesystem permissions.

## 3. Open the Sol InDesign MCP Bridge panel

Open **Sol InDesign MCP Bridge** from InDesign's plugin/panel UI. If the panel is hidden, close and reopen it once to exercise its shown lifecycle.

Pass criteria:

- the panel renders the CMYK registration strip and a readable production-console layout;
- visible controls include **Pair token**, **Connect**, **Disconnect**, **Select workspace**, **Clear workspace authorization**, and **Copy diagnostic information**;
- status text (not color alone) shows server connection, authentication, InDesign/plugin/protocol versions, workspace authorization, active document, queue depth, transport/heartbeat, and last error;
- keyboard focus is visible and the panel remains usable at a compact width;
- opening/showing the panel starts bounded reconnect attempts without blocking InDesign.

Record whether the panel had to be opened once for the session; that behavior is expected and documented.

## 4. Pair the plugin

If no server token exists, run in native PowerShell:

```powershell
pnpm setup:token
```

Configure Codex from `.codex\config.toml.example`, restart Codex, and confirm `indesign` appears in the MCP server list. This lets Codex own the STDIO server. Do not run a duplicate bridge on port 32145.

In the panel, choose **Pair token**, paste the displayed setup value once, submit it, and connect if needed.

Pass criteria:

- the token field is masked and cleared after submission;
- the panel reports authenticated protocol `sol-indesign-bridge/1`;
- the raw token does not appear in the UDT console, server stderr/audit log, panel diagnostics, clipboard diagnostic output, or Codex transcript;
- reconnecting authenticates again without asking for the token;
- only one plugin connection becomes active.

If testing negative behavior, use a deliberately wrong token at most once, confirm a safe `BRIDGE_AUTH_FAILED`, then pair correctly. Do not repeatedly trigger the rate limit during the main smoke run.

## 5. Select a workspace

Choose **Select workspace** in the panel and select the empty test directory prepared above.

Pass criteria:

- the panel changes to `workspace authorized` without displaying a native absolute path in copied diagnostics;
- authorization survives one panel close/reopen through a UXP persistent folder token;
- the bridge token remains in secure storage and is not mixed with the workspace token;
- **Clear workspace authorization** is present but is not used during the remaining steps.

Optionally attempt one harmless invalid path through a dry-run (for example `../escape.png`) and confirm `PATH_NOT_ALLOWED`; do not make this optional check a prerequisite for the numbered run.

## 6. Run `indesign_status`

In Codex, submit:

```text
Call indesign_status only. Report the bridge, authentication, plugin, InDesign,
workspace, active-document, queue, capability, heartbeat, and last-error fields.
Do not modify InDesign.
```

Pass criteria:

- the tool succeeds within 5 seconds and returns a trace ID;
- `bridgeConnected`, `authenticated`, and `workspaceAuthorized` are true;
- server/plugin/InDesign versions and bridge protocol are populated;
- queue depth is bounded and returns to zero;
- capabilities match the loaded host and no unsupported capability is reported as supported;
- there is no document mutation, new Undo entry, or unexpected stdout text.

Record the full bounded structured result after checking that it contains no secret or native workspace path.

## 7. Create an A4 document

Close other disposable test documents or take care to distinguish them. Then ask Codex:

```text
Call indesign_status. Create one new portrait A4 document with one page,
facing pages disabled, and default safe margin/bleed values. This is the only
write that has no pre-existing document revision. Return the explicit
documentRef and do not create artwork yet.
```

Approve `indesign_create_document` when Codex shows the exact operation.

Pass criteria:

- exactly one document is created with A4 portrait dimensions and one page;
- the returned `DocumentRef` has a document UUID, display name, revision 1, and persistent identity;
- the result does not rely only on the active-document name;
- the document remains open and no file is saved outside the workspace.

Keep the returned document reference for every remaining tool call.

## 8. Create an `MCP Artwork` layer

Ask Codex:

```text
Call indesign_status and get a fresh bounded snapshot for the explicit document
created in step 7. Using that documentRef and exact snapshot revision, dry-run
one ensure_layer operation for a visible, unlocked layer named "MCP Artwork".
If validation succeeds, show the plan and ask before applying that one-operation
batch. Do not target a document by display name or current selection.
```

Approve `indesign_apply_operations` only after the dry-run reports no mutation and the expected document/revision are correct.

Pass criteria:

- dry-run creates no layer and no Undo entry;
- real execution creates exactly one `MCP Artwork` layer;
- the response returns a new document revision and the batch's unique Undo label;
- running the validation again would resolve the typed layer collection rather than create a duplicate;
- the layer is visible and unlocked.

Record the new revision for step 9.

## 9. Add, edit, and group artwork in one batch

Ask Codex:

```text
Call indesign_status and refresh the snapshot for the explicit document. Using
its current revision, dry-run one batch on page 1 and layer "MCP Artwork" that:
1) creates a rectangle at x=20 mm, y=20 mm, width=70 mm, height=35 mm with alias
"heroBox"; 2) creates an oval at x=100 mm, y=20 mm, width=35 mm, height=35 mm
with alias "heroOval"; 3) creates a text frame at x=20 mm, y=65 mm,
width=120 mm, height=20 mm with alias "headline"; 4) sets the headline text to
"Sol InDesign MCP smoke test" by targeting that alias; and 5) groups heroBox
and heroOval on "MCP Artwork" with alias "heroGroup". Preserve this exact
operation order. If validation succeeds, show the entire plan and ask before
executing exactly the same batch.
```

Approve the single `indesign_apply_operations` call.

Pass criteria:

- dry-run reports no document/file changes, validates all five operations, and
  proves the planned items share one grouping container and unlocked layer;
- the real call creates one rectangle, one oval, and one text frame, sets the
  text, and creates a group containing exactly the rectangle and oval;
- all operations run against page 1 and `MCP Artwork` in the explicit document;
- the response returns `heroBox`, `heroOval`, `headline`, and `heroGroup`
  references, including persistent UUIDs, plus one exact human-readable Undo label;
- the group has exactly two direct members with the returned `heroBox` and
  `heroOval` native IDs;
- the revision increments once for the successful batch;
- InDesign's Undo menu shows that same single batch label;
- no partial-change or preference error is present.

Save the exact Undo label for step 14. Do not make further document mutations before that step.

## 10. Export a PNG preview

Ask Codex:

```text
Call indesign_status and get a fresh snapshot for the explicit document. Export
page 1 with indesign_export_preview to previews/sol-smoke.png, maximum dimension
1200 px, overwrite false, using the current document revision. Return and
inspect the MCP PNG image content and metadata. Do not alter the document.
```

Approve the output-file tool.

Pass criteria:

- the tool succeeds within 110 seconds;
- the returned path is exactly `previews/sol-smoke.png`, never an absolute path;
- the returned MCP content includes a decodable PNG image and bounded metadata;
- the maximum dimension is at most 1,200 px and file size is at most 4 MiB;
- the preview visibly contains both the rectangle and the expected headline;
- the source document revision does not increment for this file-only export;
- touched PNG export preferences are restored after the call.

Record pixel dimensions, byte size, relative path, trace ID, and a screenshot of the returned preview.

## 11. Save a copy

Ask Codex:

```text
Call indesign_status and get a fresh snapshot for the explicit document. Using
its current revision, call indesign_save_copy with target
copies/sol-smoke.indd and overwrite false. Leave the source document open and
do not change its current save location.
```

Approve the output-file tool.

Pass criteria:

- `copies/sol-smoke.indd` is created below the selected workspace;
- the source test document remains open and active;
- the source is not saved over itself, closed, renamed to a native path, or moved;
- the MCP result contains only the relative output path and safe metadata;
- document revision is unchanged by the file-only save-copy action.

Do not open the saved copy during this run because doing so can make the target document ambiguous.

## 12. Export PDF

In InDesign, identify an installed PDF preset by its exact localized name. A common English installation provides `[High Quality Print]`, but do not assume that name exists.

Ask Codex, replacing `<exact installed preset>`:

```text
Call indesign_status and get a fresh snapshot for the explicit document. Using
its current revision, call indesign_export_document to export PDF page 1 to
exports/sol-smoke.pdf with named preset "<exact installed preset>" and
overwrite false. Do not send an arbitrary export-preference property bag.
```

Approve the output-file tool.

Pass criteria:

- `exports/sol-smoke.pdf` is created below the workspace and opens as a valid one-page PDF;
- the PDF visibly contains the rectangle and headline;
- the exact named preset is used, with no silent substitution;
- result paths are workspace-relative;
- the source document revision is unchanged;
- every touched PDF/export preference is restored in success and no native path leaks to Codex.

If an intentionally nonexistent preset is tested separately, it must return `PRESET_NOT_FOUND` without creating a file or changing preferences.

## 13. Run preflight

Ask Codex:

```text
Run indesign_status, refresh the explicit document snapshot, then call
indesign_run_preflight for that document with the installed default profile and
at most 500 findings. Report the profile, pass state, error count, warning
availability/count, grouped findings, affected references, additional missing
font/link and overset checks, and truncation metadata. Do not modify the
document.
```

Pass criteria:

- the tool completes within 110 seconds or returns a structured safe timeout;
- profile name, pass state, error count, grouped results, and truncation metadata are normalized and bounded;
- `warningCount` is `null` with `warningCountAvailable: false` when the host does not expose reliable severity, rather than a fabricated value;
- missing fonts, missing/modified links, and overset text appear only as observed additional checks;
- color findings are reported only when the selected profile reports them;
- temporary preflight processes are removed and touched preferences/state are restored;
- there is no new document Undo entry or revision increment.

Record the profile and counts; document expected findings from the otherwise minimal test document.

## 14. Verify one-step Undo for the complete artwork batch

Return focus to the original test document. Do not call a mutation tool. First,
call `indesign_get_document_snapshot` for the explicit document with
`expectedUndoTraceId` set to the trace ID returned by the real batch in step 9.
Require `targetDocumentActive` and `documentUndoMatches` to be true;
`documentRedoMatches` and `proofComplete` must be false. The application-wide
Undo and Redo matches are retained as diagnostics only because InDesign 21.4.1
can report a different global stack name while the explicit active document
reports the exact batch label. Inspect all four returned artwork references and
confirm they resolve.

Inspect InDesign's **Edit > Undo** label and confirm it matches the exact batch
label returned in step 9 (file exports and preflight should not add document
Undo actions).

Invoke Undo once from InDesign.

Pass criteria:

- one Undo action removes the group, rectangle, oval, and text frame, including
  the text set through the alias;
- the `MCP Artwork` layer created in step 8 remains, proving only the complete step-9 batch was reverted;
- no unrelated user action or other document is undone;
- InDesign remains responsive and the panel reconnect/status remains healthy;
- a second read-only snapshot with the same `expectedUndoTraceId` reports
  `documentRedoMatches: true`, `createdAliasesMissing: true`, and
  `proofComplete: true`; the application-wide Redo match remains diagnostic;
- `indesign_inspect_items` reports all four created references under `missing`,
  while the explicit `MCP Artwork` layer reference still resolves;
- a final `indesign_status` reports both `groupingArrays` and
  `doScriptUndoGrouping` as `runtimeProbed` for this live plugin session.

This test proves exact array grouping and one-step Undo grouping for this
host/runtime. It does not make the batch an ACID transaction. Record the four
aliases, operation trace ID, exact label, pre/post snapshot trace IDs,
before/after screenshots, and final capability status.

## Result record

Complete one row per step during the next clean run. The template remains `Not run` because the 2026-07-15 exploratory probes were not one uninterrupted acceptance run. A release-ready result requires all rows to pass; `Not run`, `Blocked`, or `Partial` is not a pass.

| Step | Result | Trace ID / command evidence | Notes |
| ---: | --- | --- | --- |
| 1 | Not run |  |  |
| 2 | Not run |  |  |
| 3 | Not run |  |  |
| 4 | Not run |  |  |
| 5 | Not run |  |  |
| 6 | Not run |  |  |
| 7 | Not run |  |  |
| 8 | Not run |  |  |
| 9 | Not run |  |  |
| 10 | Not run |  |  |
| 11 | Not run |  |  |
| 12 | Not run |  |  |
| 13 | Not run |  |  |
| 14 | Not run |  |  |

Final disposition:

```text
[ ] PASS — all 14 steps passed in stable InDesign with evidence.
[ ] FAIL — one or more steps failed; issue references:
[x] PARTIAL — all functional surfaces, including exact grouping and one-step Undo, have real-host evidence; a clean immutable-commit release record and Adobe distribution identity remain pending.
[ ] NOT RUN — UXP Developer Tool or the target stable host is unavailable.
```

Before publishing evidence, remove the pairing token, nonce/digest/auth frames, usernames, native paths, document content not created by this test, environment dumps, and raw stack traces. Keep safe trace IDs, versions, result codes, relative paths, screenshots of the synthetic document, and redacted UDT/server diagnostics.
