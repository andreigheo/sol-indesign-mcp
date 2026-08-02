# Repository instructions

These rules apply to the entire `sol-indesign-mcp` repository. More specific `AGENTS.md` files may add constraints for a subtree but may not weaken these safety rules.

## Mission and supported architecture

Build and maintain a production-quality local Codex-to-InDesign integration for native Windows:

```text
Codex STDIO -> Node MCP server -> authenticated 127.0.0.1 bridge -> InDesign UXP plugin -> InDesign DOM
```

UXP is the only implemented InDesign adapter. Preserve the adapter boundary for a possible future COM/ExtendScript implementation, but do not add that fallback without an approved ADR and explicit task scope. Do not use UI automation.

Supported pinned foundations are native Windows Node 22.22.3, pnpm 11.13.0, TypeScript 6.0.3, stable `@modelcontextprotocol/sdk` 1.29.0, and Zod 4.4.3 imported through `zod/v4`. Do not add an MCP SDK v2 beta dependency.

## Non-negotiable implementation rules

- Preserve strict TypeScript project references, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Do not use explicit `any`, `@ts-ignore`, unchecked casts, or disabled lint/type rules to bypass a design problem. Narrow `unknown` with explicit guards.
- Define all bridge messages, tool inputs/outputs, references, operations, and structured errors once in `packages/protocol` with strict Zod schemas.
- Keep MCP SDK-specific registration isolated in the MCP server registration module.
- Do not add arbitrary script execution, `eval`, indirect eval, `new Function`, string-form `app.doScript`, shell execution, arbitrary ExtendScript/VBScript, dynamic DOM member names, or arbitrary property bags.
- Do not broaden UXP permissions without an accepted ADR, threat-model update, and tests. Network permission must remain limited to the two port-qualified localhost origins in ADR 0005; plugin transport code stays fixed to those origins and the server remains bound only to `127.0.0.1:32145`.
- Do not write logs, banners, diagnostics, or ordinary text to stdout in the MCP server. Stdout is MCP protocol only; use structured stderr or rotating audit files.
- Do not add an absolute-path input to an MCP tool or send a native path across the bridge. Validate workspace-relative paths independently on server and plugin.
- Do not change the default `overwrite: false`. Existing files return `FILE_EXISTS`; replacement requires explicit `overwrite: true` and destructive approval.
- Do not modify documents from read-only tools, including assigning persistent UUID labels during inspection.
- Never resolve a write target solely by name, collection index, current selection, or geometry. Re-resolve explicit references inside the serial queue and verify ownership, kind, revision, UUID, and fingerprint when supplied.
- Send every InDesign DOM read and write through the single plugin FIFO queue.
- Validate an operation batch completely before calling function-form `app.doScript`. Report partial changes and the exact Undo label; never blindly call global Undo after failure.
- Snapshot and restore every touched readable preference in `finally`.
- Keep outputs bounded. Do not expose complete stories, raw DOM objects, secrets, authentication messages, environment dumps, native paths, file contents, or raw stack traces.
- Return structured, user-safe errors with `code`, `message`, `traceId`, `retryable`, and bounded optional details.
- Fail closed with `UNSUPPORTED_CAPABILITY` when a runtime-dependent Adobe API is absent.

## Adobe API discipline

Before using an InDesign DOM member, verify it in the current official [InDesign UXP DOM reference](https://developer.adobe.com/indesign/uxp/dom/api/). Keep a narrow local type declaration only for members actually used. Add runtime feature detection for version-dependent behavior.

Do not infer that ExtendScript examples, Photoshop UXP APIs, browser APIs, or legacy InDesign scripting members are available in InDesign UXP. Record any undocumented host behavior as unverified until a real UDT/InDesign probe demonstrates it.

## Security boundaries

- Bind the bridge only to `127.0.0.1:32145`.
- Require protocol negotiation and challenge-response authentication before any operational frame.
- Never log the shared token, nonce, digest, authentication frame, or full environment.
- Keep the server credential outside the repository and the plugin credential in UXP `secureStorage`.
- Keep workspace persistent-token storage separate from secret storage.
- Reject traversal, absolute/drive/UNC/file-URL paths, backslashes, unsafe empty/dot segments, controls, trailing dot/space segments, and Windows device names.
- Treat MCP annotations and Codex approvals as operator UX, not enforcement. Repeat security checks in deterministic handlers.
- Preserve message, output, queue, deadline, authentication-attempt, diagnostic-history, and reconnect bounds.

Read [SECURITY.md](SECURITY.md) before changing authentication, transport, path handling, identity, mutation, export, logging, manifest permissions, or packaging.

## Testing requirements

Add focused tests for every new operation, DOM adapter member, error mapping, and security boundary. Include success, schema rejection, stale/mismatch behavior, runtime unsupported behavior, and partial/failure cleanup where relevant.

Before handing off a change, run the narrowest useful tests while iterating, then the native-Windows acceptance gate:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm build
pnpm verify
```

For token, doctor, manifest, or package work also run the applicable command:

```powershell
pnpm setup:token
pnpm doctor
pnpm package:uxp
pnpm sync:uxp-host
```

Do not suppress a TypeScript or test failure. Distinguish unit/mock evidence from real-host evidence in every handoff.

## Real-host claims

Do not claim a real InDesign integration test passed without evidence from stable InDesign loaded through UXP Developer Tool. The evidence must identify the InDesign/plugin versions and cover the current 14-step [manual integration test](docs/manual-integration-test.md), including preview, save-copy, PDF, preflight, and one-step Undo.

As of 2026-07-16, UXP Developer Tool 2.2.1.2 has loaded the final development build in stable InDesign 21.4.1 / UXP 9.3. All eleven tools, all sixteen executable operation variants, authenticated WebSocket and HTTP fallback, UXP file placement/export/save, atomic color creation, bounded preflight, exact grouping membership, grouped-child reference resolution, and the required human-observed one-step Undo have real-host evidence. A distribution claim still requires an Adobe-issued plugin ID and an immutable release record.

## Change workflow

1. Inspect `git status` and preserve unrelated/user changes.
2. Read the applicable protocol/domain/adapter code and ADRs before editing.
3. Prefer a narrow vertical change over a broad placeholder. Never return fake success from an unimplemented handler.
4. Update protocol schemas before consumers and keep server/plugin versions compatible.
5. Add tests in the same change.
6. Run native-Windows verification and record the exact commands/results.
7. Update operator/security/manual documentation when behavior or limits change.

Do not reset, delete, or rewrite unrelated work. Do not commit generated credentials, `.codex/config.toml`, logs, workspace tokens, UDT state, exported documents, or test documents containing private content.
