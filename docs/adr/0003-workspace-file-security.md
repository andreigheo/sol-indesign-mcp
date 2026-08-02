# ADR 0003: Confine file access to one UXP-authorized workspace

- Status: Accepted
- Date: 2026-07-14
- Decision owners: Sol InDesign MCP maintainers

## Context

Preview, place, save-copy, and export operations need local file access. Accepting native absolute paths from MCP would let a caller probe or modify any file reachable by the Windows user and would couple Node path semantics to UXP entry semantics. Requesting full filesystem access would make a prompt or validation mistake much more damaging.

UXP provides a user-mediated folder picker and persistent tokens for later access to the selected entry. The project also needs predictable cross-runtime validation because the Node server and UXP plugin are separate trust boundaries.

## Decision

The user selects exactly one workspace directory through the UXP folder picker under `localFileSystem: "request"`. The plugin stores the folder's UXP persistent token in ordinary plugin persistent storage. It stores the bridge authentication secret separately in UXP `secureStorage`.

Every file-bearing tool and operation accepts only an NFC-normalized, `/`-separated workspace-relative path. The Node server validates the portable path before sending a request. The plugin independently validates it again, resolves it segment by segment below the authorized UXP folder entry, and verifies containment.

Both boundaries reject:

- absolute, rooted, drive-letter, drive-relative, UNC, and device paths;
- `file:` URLs and URI-shaped input;
- backslashes;
- empty, `.` or `..` segments;
- control characters;
- segments with trailing dots or spaces;
- Windows reserved device names, including names with extensions;
- values that violate the required Unicode normalization;
- any resolution outside the authorized folder.

The plugin tries the UXP File entry directly with the verified InDesign DOM. If a host requires `getNativePath`, it may convert only inside the plugin and only after containment validation. A native path never crosses the bridge, appears in an MCP result, or becomes a tool input.

All output schemas default `overwrite` to false. If the target exists, the operation returns `FILE_EXISTS`. Replacement requires explicit `overwrite: true`; every tool that can accept replacement is advertised as destructive and configured for prompt approval.

The panel provides **Select workspace** and **Clear workspace authorization** controls. A stale/invalid persistent token fails with `WORKSPACE_NOT_AUTHORIZED` and requires user selection; the plugin does not silently broaden access.

## Consequences

### Positive

- The user chooses the only filesystem root available to the integration.
- Server-side validation gives early, portable error messages; plugin-side validation remains the authoritative containment boundary.
- Prompts and tool results can use stable relative paths without leaking the Windows profile or native directory layout.
- UXP entry semantics avoid direct dependence on Node filesystem access inside the plugin.
- Output collision is safe by default.

### Negative

- Inputs that need to be placed must first exist under the selected workspace.
- The user must reauthorize when UXP invalidates a persistent folder token.
- Symlink/alias and native-path edge cases must fail closed unless the installed runtime can prove containment.
- The operation DSL cannot place from URLs, arbitrary Windows paths, or other workspaces.
- Explicit overwrite remains destructive even inside the workspace and needs operator review.

## Rejected alternatives

### Absolute paths checked only by Node

The plugin is a separate security boundary and cannot trust Node validation. Native path normalization also differs across runtimes and can leak local path information.

### UXP full filesystem permission

Full access is unnecessary for the supported workflow and materially increases the impact of a malformed or malicious request.

### Path validation only in the plugin

This would preserve the ultimate boundary but send avoidable hostile paths over the bridge and produce later, less useful failures. Defense in depth is inexpensive here.

### One folder token per operation

Repeated pickers make batch workflows unusable. One persistent workspace token provides a clear, revocable authorization scope.

### Automatic overwrite or timestamp renaming

Automatic overwrite risks data loss, while silent renaming makes the returned path surprising. The caller must choose a new name or explicitly authorize replacement.

## Validation

- Unit tests cover Unicode normalization, traversal, drive/UNC/file URLs, slash policy, empty/dot segments, controls, trailing dots/spaces, device names, extensions, containment, and collision defaults.
- Contract tests confirm native paths never appear in bridge messages or tool results.
- UXP integration testing must confirm persistent-token rehydration, stale-token failure, segment walking, direct File-to-DOM behavior, and any guarded native-path fallback.
