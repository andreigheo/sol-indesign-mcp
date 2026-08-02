# ADR 0004: Use explicit persistent identity, revisions, and labeled Undo batches

- Status: Accepted
- Date: 2026-07-14
- Decision owners: Sol InDesign MCP maintainers

## Context

InDesign object names, collection indexes, current selection, and geometry are not stable identities. A request can wait in the serial queue while the user changes the active document or edits page items. The integration therefore needs references that can be re-resolved safely, optimistic concurrency for MCP mutations, and transparent behavior when an operation partially fails.

InDesign can attach labels to documents and page items, but a read-only MCP tool must not dirty a user's document merely to improve future identity. InDesign also provides an Undo grouping mechanism, but one Undo step is not a transactional rollback facility.

## Decision

### Document identity

Every `DocumentRef` contains:

- `documentUuid`;
- optional native ID;
- display-only name;
- plugin-maintained revision;
- `identityPersistent`, indicating whether the UUID is stored in the document.

A newly created MCP document starts at revision 1 with persistent identity. An existing unlabeled document receives a session UUID for reads without mutation. During the first sanctioned write, the plugin persists that same UUID under the document label `com.sol.indesign-mcp.document-uuid` as part of the write.

The explicit document is re-resolved immediately before queued DOM execution. The plugin verifies identity rather than substituting whichever document is active at that moment.

### Object identity

Every `InDesignObjectRef` contains the owning document UUID, native ID, kind, and optional persistent UUID, name/page display metadata, and fingerprint. Resolution uses the document plus native ID for speed, then verifies owner document, kind, optional persistent UUID, and supplied fingerprint. A page item is never resolved solely by index, name, selection, geometry, or active page.

Read tools do not write an object label. When MCP creates or first modifies an unlabeled object, it persists `com.sol.indesign-mcp.object-uuid` and a closed `com.sol.indesign-mcp.object-kind` semantic label inside the same write batch. InDesign 21.4.1 can expose Rectangle and Oval children as generic `PageItem` proxies after grouping and omit them from the flat typed document collections. The kind label is accepted only beside a valid MCP UUID; bounded nested traversal (10,000 objects, depth 8) then permits the same explicit typed reference to resolve without falling back to name, index, selection, or geometry.

### Revisions and fingerprints

Every write to an existing document accepts an explicit `documentRef` and `expectedRevision`. A mismatch returns `STALE_DOCUMENT`. The revision increments after every successful MCP document mutation and after a partial mutation. File-only export does not increment document revision.

Revision state is stored separately from the secret and workspace token in ordinary UXP persistent storage, keyed by the persistent document UUID plus native document ID. After validation, the plugin reserves the next revision before entering the DOM write. It commits the reservation after success or partial mutation and restores the prior revision when execution confirms no mutation. A crash or failed rollback may leave a harmless gap, but an older revision cannot become current after plugin Reload. Clearing plugin persistent data is an explicit coordination reset; all previously issued references must then be discarded.

Where stable relevant properties are available, snapshots return an object fingerprint. A supplied mismatch returns `OBJECT_STALE`. Revisions and fingerprints are optimistic MCP coordination; they do not claim to detect every manual InDesign edit.

### Batch planning and Undo

`indesign_apply_operations` first performs a complete validation/resolution pass, including alias planning and resource/path checks. `dryRun: true` returns that result without document or file changes. Real execution reuses the validated plan and calls:

```ts
app.doScript(
  () => executeValidatedOperations(...),
  ScriptLanguage.UXPSCRIPT,
  [],
  UndoModes.ENTIRE_SCRIPT,
  uniqueUndoLabel,
);
```

Every batch receives a unique, human-readable label and should appear as one Undo step. Execution records each completed operation. If an unexpected DOM failure follows a mutation, the response is `PARTIAL_FAILURE` and contains `partialChanges`, completed operations, `undoRecommended: true`, and the exact Undo label.

The plugin never blindly invokes global Undo after an exception because a concurrent human action may otherwise be undone. All DOM work, including reads, is serialized through one plugin FIFO queue.

## Consequences

### Positive

- Queued requests target an explicit document/object rather than mutable application focus.
- Native IDs provide fast lookup while ownership, UUID, kind, and fingerprint guard against reuse or mismatch.
- Read-only tools preserve document cleanliness.
- Revision errors force the caller to inspect state before retrying.
- Plugin Reload preserves the last reserved/committed revision and cannot create an ABA collision with an older reference.
- A batch gives the user one identifiable Undo action and exposes partial failure honestly.
- Dry-run and real execution share validation semantics.

### Negative

- Session-only UUIDs do not survive closing an unlabeled document before its first sanctioned write.
- Persisting identity on first modification is itself part of the mutation and Undo group.
- A crash before confirmed DOM completion can leave a conservative revision gap.
- Manual edits are not exhaustively detected by the plugin revision.
- A single Undo group is not atomic: host errors may leave partial changes until the user chooses Undo.
- Fingerprints must remain bounded and use only stable, relevant properties; they cannot be complete object hashes.
- Serializing reads can reduce throughput, but it avoids unproven DOM concurrency.

## Rejected alternatives

### Resolve by name or collection index

Names are not unique and indexes change whenever the document structure changes. Both can silently target the wrong object.

### Assign UUID labels during every read

Inspection would dirty user documents and violate read-only tool semantics.

### Use current selection as the write target

Selection can change while a request waits and makes prompts ambiguous. Selection is inspectable only; writes require explicit references.

### Treat `doScript` as an ACID transaction

Undo grouping does not guarantee rollback on exception. Claiming atomicity would hide possible partial document changes.

### Always call Undo after failure

An automatic global Undo can affect a user's intervening action and is therefore unsafe.

### Use the application-wide stack as the batch authority

InDesign 21.4.1 can expose an `Application.undoName` or `Application.redoName` that differs from the exact action reported by the explicit active document. The document-scoped values are authoritative for MCP document mutations; application-wide matches are retained only as bounded diagnostics. A global match never compensates for a document mismatch.

### Run reads concurrently

The InDesign DOM's thread/concurrency safety has not been established for this plugin. The conservative queue is the supported behavior.

## Validation

- Unit tests cover ownership, document mismatch, stale revision, stale fingerprint, alias resolution, dry-run zero mutation, and revision increment after partial changes.
- Fake-adapter contract tests verify re-resolution after queue wait and exact partial-failure metadata.
- The manual test verifies that a multi-operation batch is one visible Undo step in stable InDesign.

As of 2026-07-16, UXP Developer Tool 2.2.1.2 has loaded the final development build in stable InDesign 21.4.1. An uninterrupted automated run passed dry-run, a 15-operation `doScript` batch, stale revision rejection, placement, file outputs, and preflight. A later exact five-operation batch proved grouping and final alias resolution; the explicit document exposed the returned Undo label, one human Undo removed all four created aliases, the earlier sentinel layer remained, the matching Redo label appeared, and `doScriptUndoGrouping` advanced to `runtimeProbed`.
