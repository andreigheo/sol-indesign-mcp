# ADR 0001: Use InDesign UXP as the primary bridge

- Status: Accepted
- Date: 2026-07-14
- Decision owners: Sol InDesign MCP maintainers

## Context

Codex communicates with local tools through MCP, but a native Node.js process does not have direct access to the live Adobe InDesign document object model. The integration needs to inspect and change the document currently open in the user's InDesign process while preserving application identity, Undo behavior, export settings, and user-authorized file access.

Candidate integration mechanisms were:

1. a dedicated InDesign UXP plugin;
2. Windows COM or a COM-launched ExtendScript bridge;
3. arbitrary script text passed from MCP to InDesign;
4. UI automation with simulated keyboard and mouse input;
5. a remote service or cloud plugin.

The target is the latest installed stable InDesign on Windows, with local operation and no arbitrary code execution. Adobe's current extension model and documented InDesign DOM are available through UXP. UXP also supplies secure secret storage and user-mediated local filesystem entries.

## Decision

Use a dedicated manifest-v5 UXP panel as the only implemented InDesign adapter.

The panel obtains the host API with:

```ts
const { app, ScriptLanguage, UndoModes } = require("indesign");
```

It accepts only versioned, schema-validated bridge messages and maps them to an exhaustive allowlist of typed domain operations. It serializes all DOM reads and writes through one FIFO queue. Raw DOM objects never cross the bridge.

The Node MCP server and domain packages expose an `InDesignAdapter` interface so another implementation could be added later. COM/ExtendScript is not implemented in the MVP and must not be silently introduced as a fallback.

Before using a DOM member, maintainers must verify it in Adobe's current [InDesign UXP DOM reference](https://developer.adobe.com/indesign/uxp/dom/api/) and add runtime detection when availability varies. An unavailable or unverified capability returns `UNSUPPORTED_CAPABILITY`.

## Consequences

### Positive

- Document access occurs inside the owning InDesign process through Adobe's supported extension boundary.
- The plugin can use InDesign's function-form `app.doScript` and `UndoModes.ENTIRE_SCRIPT` for one labeled Undo step.
- UXP provides `secureStorage`, a user-mediated workspace picker, and persistent folder tokens.
- The manifest can constrain host, loopback origins, filesystem access, clipboard behavior, and runtime code generation.
- The operation DSL and adapter boundary are independently testable with a Node fake adapter.
- No desktop UI automation or global COM registration is required.

### Negative

- The user may need to open the panel once per InDesign session; plugin auto-start is not assumed.
- Development loading, manifest verification, and real-host tests require UXP Developer Tool.
- UXP runtime differences can affect plain loopback WebSocket, UXP File-to-DOM conversion, grouping, and preflight behavior.
- Node-only tests cannot prove that a documented API behaves as expected in the installed host.
- A future fallback adapter will require a separate decision, threat model, implementation, and acceptance suite.

## Rejected alternatives

### COM/ExtendScript as the MVP

COM is Windows-specific, expands the process and script-execution boundary, and encourages passing untyped script strings. It is reserved as a possible future adapter, not an implicit escape hatch.

### Arbitrary JavaScript or ExtendScript tool

An arbitrary executor would turn prompt content into code running with document and file capabilities. It violates the allowlisted-operation requirement and is prohibited.

### UI automation

Coordinates, focus, dialogs, and selection are unstable and can target the wrong user document. UI automation provides weaker identity and error semantics than the DOM and is prohibited.

### Remote/cloud bridge

The application and files are local. A remote bridge would add data-exfiltration and authentication surfaces without solving host DOM access.

## Validation

- Unit and contract tests use the adapter boundary and fake adapter.
- Bundle inspection rejects `eval` and `new Function` patterns.
- Manifest tests constrain permissions to the two approved port-qualified localhost origins; ADR 0005 documents why the UXP client uses localhost while the server remains literal IPv4 loopback.
- The 14-step real-host smoke test must be completed before release readiness is claimed.

As of 2026-07-16, UXP Developer Tool 2.2.1.2 has loaded the final development build in stable InDesign 21.4.1 / UXP 9.3. All eleven tools, all sixteen executable operation variants, placement, preview, save-copy, PDF/PNG/JPEG/IDML, preflight, exact grouping membership, grouped-child reference resolution, and a human-observed one-step Undo have real-host evidence.
