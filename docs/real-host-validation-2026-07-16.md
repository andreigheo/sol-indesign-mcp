# Comprehensive automated real-host validation — 2026-07-16

This record captures the first uninterrupted automated MCP-to-InDesign run across all eleven registered tools plus the final installed-host grouping and human one-step Undo proof. All sixteen production operation variants now have real-host evidence. It is not an Adobe distribution claim: an Adobe-issued plugin ID and an immutable release record are still required.

## Environment and build identity

- Windows: 10.0.26100.8655
- Native Node: win32 v22.22.3
- pnpm: 11.13.0
- InDesign: stable 21.4.1.4
- UXP runtime: 9.3.0-local
- UXP Developer Tool: 2.2.1.2
- Plugin: 0.1.0, development load
- Bridge protocol: `sol-indesign-bridge/1`
- Final transport: authenticated WebSocket
- Additional real transport evidence: authenticated HTTP long polling, including operational document requests
- Workspace: dedicated synthetic test workspace; only relative paths are recorded
- Git commit: unavailable because the repository has no initial commit
- Final manifest SHA-256: `f1dea3a34ed5d406548ad6944d3d124a4e48d3b1e40febac54182154c590769e`
- Final UXP bundle SHA-256: `915ab45f2d1ef453748ca99a4822adbf0774a48ec7d0a2401f79fab7b277d58f`
- Final development CCX SHA-256: `7485a554cec4adf2411e6915f5f89297210819beb9553b1e836aa73dbfda6086`

`pnpm sync:uxp-host` proved the source manifest, built four-file plugin, registered External copy, and canonical CCX were byte-for-byte consistent before the final UDT Unload/Load.

## Final uninterrupted MCP run

The final client spawned the production STDIO server, listed exactly eleven tools with no delete tool, waited for UXP authentication, and then used explicit references throughout. The session ran from 06:12:49Z to 06:12:59Z and ended cleanly on STDIO EOF.

| Area | Result | Bounded evidence |
| --- | --- | --- |
| Status and authentication | Pass | Trace `7ec6bc89-aa81-47cd-81c1-01d03836c17e`; bridge connected and authenticated over WebSocket; workspace authorized. |
| List documents | Pass | Trace `2892bb7b-a1f4-457d-9525-5ae542c7c294`; bounded explicit document references. |
| Create document | Pass | Trace `b774fadb-9084-4ab6-9c51-872f1b81d5eb`; one-page portrait A4 document at revision 1 with persistent identity. |
| Snapshot | Pass | Initial trace `2fcca7bf-5338-4aa8-b2ee-e836c5c2d374`; final trace `54b7a715-6279-45bc-8ae8-d2fc7ea9aebb`. |
| Selection | Pass | Trace `6b07fe37-16b7-4b76-9d58-f5b28e6e8840`; explicit document and bounded result. |
| Operations dry-run | Pass | Trace `f5c63b2f-89b2-4581-89f4-23d1fd94463e`; 15 operations validated with zero completed mutations and unchanged revision. |
| Operations execution | Pass | Trace `5ae025d5-d3b6-4510-8326-f520c5770d33`; all 15 operations completed in one labeled `doScript` batch and revision advanced 1→2. |
| Inspect explicit items | Pass | Trace `078e78aa-68f5-4533-b090-014c403c2b9e`; page items and typed resources resolved by returned references. |
| Preview | Pass | Trace `91ec6f0f-8d54-453e-8fb4-c63ff54d2a91`; `previews/sol-real-20260716061248.png`; 843×1193; 13,831 bytes; visually inspected. |
| Place file | Pass | Trace `a0a55382-934f-4cf8-9dce-2b975e027f43`; placed the authorized preview through the typed `place_file` operation and advanced revision 2→3. |
| Save copy | Pass | Trace `68067ea5-21f0-4a1e-80da-4067af5a5cf1`; `copies/sol-real-20260716061248.indd`; 1,118,208 bytes; recognized as an Adobe InDesign document. |
| PDF export | Pass | Trace `7e9116ce-86b5-44e5-b6c4-814a50a9f58c`; `[High Quality Print]`; `exports/sol-real-20260716061248.pdf`; 45,524 bytes; valid one-page A4 PDF 1.4. |
| PNG export | Pass | Trace `06af8219-2e87-4a6c-95cf-401330f45f69`; `exports/sol-real-20260716061248.png`; valid 595×842 RGB PNG. |
| JPEG export | Pass | Trace `ebf927bc-18f6-4002-abab-4583c7751807`; `exports/sol-real-20260716061248.jpg`; valid 595×842 JFIF JPEG. |
| IDML export | Pass | Trace `73dbeafc-10c7-49c6-a9dd-aa030cc2a381`; `exports/sol-real-20260716061248.idml`; ZIP integrity test passed without errors. |
| Preflight | Pass | Trace `45b5f223-7037-4fb0-ac10-d744677c067b`; `[Basic]`; passed; 0 errors; `warningCount: null`; warning availability false; process cleanup completed. |
| Final status/list | Pass | Traces `14806ebb-4391-4058-855d-5f384216e02d` and `d7c05507-12f0-47ba-8265-062d0ed168e9`; authenticated, queue drained, document remained open at revision 3. |

The visually inspected preview showed the expected rectangle, oval, and headline. The new CMYK color appeared on both the rectangle and paragraph style, proving the installed UXP host accepted the corrected atomic color creation path.

## Direct Codex task proof

A fresh Codex CLI 0.144.2 task discovered the configured `indesign` STDIO server and called the real installed-host tools without a separate manually started bridge server:

- `indesign_status` passed under trace `cebcb1ea-7340-4b08-8cb5-087632298dd9`: authenticated HTTP fallback, InDesign 21.4.1.4, plugin 0.1.0, workspace authorized, queue depth 0, active document revision 2.
- `indesign_apply_operations` passed under trace `da9baba7-c49f-4dad-aac1-a0dc9e63ac22` with one `ensure_layer` operation in `dryRun: true`: one operation validated, zero completed mutations, no warnings or partial changes, and revision remained 2.
- A separately authorized live Codex task then created the layer `Codex Live Control Test` under trace `8cc131c8-c047-4fa6-84ff-910beea5ac8e`: one operation completed, no warnings or partial changes, and the active document revision advanced 2→3. Follow-up status trace `b723a53f-af17-4907-87c6-d90998f114a1` confirmed the new revision with an empty queue.
- The final shared Codex configuration uses `node.exe` from the inherited Windows PATH so both Windows-hosted and WSL-routed Codex tasks launch the pinned native Windows Node. A fresh task used that configuration without MCP command/cwd overrides and authenticated on its first status call under trace `0e3f292e-ad00-49ca-b995-6f8d2c2d6210`, confirming revision 3.
- An earlier read-only Codex task listed the active document under trace `f8c94f0a-15c9-49b3-81f5-9d5045c742ec`.

The direct task exposed a Codex 0.144.2 schema-ingestion incompatibility with Draft-07 tuple-form `items`. The protocol now advertises RGB/CMYK channels as bounded homogeneous arrays and pipes them into the same exact tuple outputs at runtime. Focused protocol and real `tools/list` contract tests guard the compatibility surface without weakening strict operation validation.

## Operation coverage

The main batch exercised `ensure_layer`, `create_page`, `create_rectangle`, `create_oval`, `create_text_frame`, `set_text`, `set_item_bounds`, `set_item_appearance`, `create_or_update_color`, `create_or_update_paragraph_style`, `apply_paragraph_style`, `create_or_update_object_style`, `apply_object_style`, and `move_item_to_layer`. A later successful batch exercised `place_file`.

The initial run exercised `group_items` only through its fail-closed path. The final build then completed an exact five-operation batch under trace `1ca95dff-36c8-442f-8f2e-2554deb8c42e`: rectangle, oval, text frame, text assignment, and `group_items`. The returned rectangle, oval, text-frame, and group aliases all resolved through trace `07ea5dba-b58c-4990-a0a4-104831f0e1e1`; the group contained exactly two direct children. InDesign's generic grouped-child proxies retained their typed UUID-backed identities through bounded nested resolution.

One human Undo was then invoked in the explicit active document. Snapshot trace `4509403c-5a62-49ad-bafd-b3e3b381a661` reported `documentRedoMatches: true`, `createdAliasesMissing: true`, and `proofComplete: true`. Inspection trace `7814e71a-85f5-477f-b8f5-027162857b52` proved all four batch aliases were absent while the earlier `MCP Undo Sentinel Final` layer remained. Final status trace `79ee60f5-5aba-4141-93cc-4636bc815a20` reported both `groupingArrays` and `doScriptUndoGrouping` as `runtimeProbed`.

## Expected security and failure-path results

| Probe | Result | Trace |
| --- | --- | --- |
| Stale revision | Correct `STALE_DOCUMENT`; expected 1, current 2 | `f79bd823-cdff-4a19-acc5-6fb9f1586b29` |
| Path traversal | Correct `PATH_NOT_ALLOWED`; dot segment rejected at segment 0 | `c245db48-0acc-4ef4-8aa5-3aecd83469d1` |
| Existing preview with `overwrite: false` | Correct `FILE_EXISTS` | `564070b5-fffe-453d-b813-90922d924c82` |
| Missing PDF preset | Correct `PRESET_NOT_FOUND`; no output created | `327181f8-a83c-4c97-8bdf-65246367a778` |
| Disabled grouping | Correct `UNSUPPORTED_CAPABILITY` before mutation | `ac11ed62-390a-468a-879d-55db4c5cec6c` |

## Transport evidence

- The clean final build authenticated over WebSocket at 06:12:49Z and carried the complete run above.
- A forced real-host fallback rejected exactly three WebSocket load-session attempts, then authenticated through HTTP long polling.
- A subsequent authenticated HTTP session carried status, list, create, snapshot, selection, dry-run, a successful 14-operation document batch, stale-revision rejection, and item inspection. Transport code did not change in the later atomic-color patch.
- The final automated suite also covers exact fallback sequencing, HTTP session lifecycle, frame limits, cancellation, and reconnect reset.

## Automated acceptance gate

The latest native-Windows command was:

```powershell
pnpm verify; pnpm doctor; pnpm sync:uxp-host
```

The final code build passed lint, strict type checking, 59 unit test files with 295 tests, 2 contract files with 18 tests, all workspace builds, STDIO purity, UXP bundle inspection, deterministic CCX packaging, and byte-identical host-copy synchronization.

## Remaining release-readiness evidence

1. Tie the final release record to an immutable Git commit after the repository receives its initial commit.
2. Replace the development plugin ID with an Adobe-issued ID and complete Adobe's distribution packaging/installation proof.

These are release-process requirements, not unresolved production adapter capabilities. The real-host tool, transport, operation, grouping, Undo, export, security, and preflight surfaces above have evidence.
