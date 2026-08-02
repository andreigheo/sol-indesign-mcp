import { describe, expect, it } from "vitest";
import {
  ApplyOperationsInputSchema,
  BoundsSchema,
  BridgeChallengeSchema,
  BridgeHelloSchema,
  ColorValueSchema,
  DocumentRefSchema,
  ExportPreviewInputSchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  OperationSchema,
  PreflightResultSchema,
  SnapshotInputSchema,
  SnapshotResultSchema,
} from "../index.js";

const documentRef = DocumentRefSchema.parse({
  documentUuid: "47f0d872-7c3a-4f56-9ab6-39d78d142b61",
  nativeId: 1,
  name: "Layout.indd",
  revision: 2,
  identityPersistent: true,
});

describe("shared protocol schemas", () => {
  it("rejects unknown keys recursively", () => {
    expect(() => BoundsSchema.parse({ x: 0, y: 0, width: 1, height: 1, unit: "mm", extra: true })).toThrow();
    expect(() => BridgeHelloSchema.parse({
      protocol: "sol-indesign-bridge/1",
      type: "hello",
      supportedProtocols: ["sol-indesign-bridge/1"],
      pluginVersion: "0.1.0",
      inDesignVersion: "21.4.1",
      transport: "websocket",
      capabilities: {},
      token: "must-not-cross-wire",
    })).toThrow();
  });

  it("accepts typed aliases and rejects delete operations", () => {
    const operation = OperationSchema.parse({
      type: "create_rectangle",
      ref: "hero",
      page: { ref: "page" },
      bounds: { x: 10, y: 10, width: 40, height: 20, unit: "mm" },
    });
    expect(operation.type).toBe("create_rectangle");
    expect(() => OperationSchema.parse({ type: "delete", target: { ref: "hero" } })).toThrow();
  });

  it("keeps color channels bounded and fixed-length", () => {
    expect(ColorValueSchema.parse({ space: "RGB", values: [1, 2, 3] }).values).toEqual([1, 2, 3]);
    expect(ColorValueSchema.parse({ space: "CMYK", values: [1, 2, 3, 4] }).values).toEqual([1, 2, 3, 4]);
    expect(() => ColorValueSchema.parse({ space: "RGB", values: [1, 2] })).toThrow();
    expect(() => ColorValueSchema.parse({ space: "CMYK", values: [1, 2, 3, 101] })).toThrow();
  });

  it("bounds operation batches", () => {
    expect(() => ApplyOperationsInputSchema.parse({
      documentRef,
      expectedRevision: 2,
      operations: [],
      dryRun: true,
    })).toThrow();
  });

  it("accepts bounded trace-derived Undo verification without exposing history", () => {
    const traceId = "fe1de7b5-1efe-40df-9f0f-5a48d1fd7b64";
    expect(SnapshotInputSchema.parse({ documentRef, expectedUndoTraceId: traceId })).toMatchObject({
      expectedUndoTraceId: traceId,
    });
    expect(() => SnapshotInputSchema.parse({ documentRef, expectedUndoTraceId: "not-a-uuid" })).toThrow();
    const asymmetric = SnapshotResultSchema.parse({
      documentRef,
      revision: 2,
      pages: [],
      layers: [],
      items: [],
      counts: {},
      undoVerification: {
        targetDocumentActive: true,
        applicationUndoMatches: false,
        documentUndoMatches: true,
        applicationRedoMatches: false,
        documentRedoMatches: true,
        createdAliasesMissing: true,
        proofComplete: true,
      },
      truncation: { truncated: false, reasons: [], returnedItems: 0 },
    });
    expect(asymmetric.undoVerification).toMatchObject({
      applicationUndoMatches: false,
      documentUndoMatches: true,
      applicationRedoMatches: false,
      documentRedoMatches: true,
      proofComplete: true,
    });
    expect(() => SnapshotResultSchema.parse({
      documentRef,
      revision: 2,
      pages: [],
      layers: [],
      items: [],
      counts: {},
      undoVerification: {
        targetDocumentActive: true,
        applicationUndoMatches: true,
        documentUndoMatches: true,
        applicationRedoMatches: false,
        documentRedoMatches: false,
        createdAliasesMissing: false,
        proofComplete: false,
        undoHistory: ["must not be accepted"],
      },
      truncation: { truncated: false, reasons: [], returnedItems: 0 },
    })).toThrow();
  });

  it("keeps apply-operation boolean defaults without advertising JSON Schema defaults", () => {
    const parsed = ApplyOperationsInputSchema.parse({
      documentRef,
      expectedRevision: 2,
      operations: [
        {
          type: "apply_paragraph_style",
          target: { ref: "bodyFrame" },
          style: { name: "Body" },
        },
        {
          type: "apply_object_style",
          target: { ref: "heroFrame" },
          style: { name: "Hero" },
        },
      ],
    });

    expect(parsed.dryRun).toBe(false);
    expect(parsed.operations[0]).toMatchObject({ clearOverrides: false });
    expect(parsed.operations[1]).toMatchObject({ clearOverrides: false });
  });

  it("accepts only canonical 32-byte base64url handshake values", () => {
    const base = {
      protocol: "sol-indesign-bridge/1",
      type: "challenge",
      expiresAt: Date.now() + 15_000,
    } as const;
    expect(() => BridgeChallengeSchema.parse({
      ...base,
      sessionId: "A".repeat(43),
      nonce: "A".repeat(43),
    })).not.toThrow();
    expect(() => BridgeChallengeSchema.parse({
      ...base,
      sessionId: `${"A".repeat(42)}B`,
      nonce: "A".repeat(43),
    })).toThrow();
  });

  it("rejects revision and document-ownership mismatches before dispatch", () => {
    expect(() => ApplyOperationsInputSchema.parse({
      documentRef,
      expectedRevision: 1,
      operations: [{
        type: "set_item_bounds",
        target: {
          objectRef: {
            documentUuid: documentRef.documentUuid,
            nativeId: 10,
            kind: "rectangle",
          },
        },
        bounds: { x: 0, y: 0, width: 10, height: 10, unit: "pt" },
      }],
    })).toThrow(/expectedRevision/u);

    expect(() => ExportPreviewInputSchema.parse({
      documentRef,
      expectedRevision: 2,
      pageRef: {
        documentUuid: "11111111-1111-4111-8111-111111111111",
        nativeId: 20,
        kind: "page",
      },
      targetPath: "previews/page.png",
      maxDimensionPx: 1_600,
      overwrite: false,
    })).toThrow(/requested document/u);
  });

  it("keeps a maximum preflight result below the bridge frame ceiling", () => {
    const finding = {
      category: "X".repeat(255),
      message: "M".repeat(1_000),
      details: Array.from({ length: 10 }, () => "D".repeat(250)),
    };
    const result = PreflightResultSchema.parse({
      documentRef,
      profileName: "Profile",
      passed: false,
      errorCount: 500,
      warningCount: null,
      warningCountAvailable: false,
      errorsByCategory: { category: Array.from({ length: 500 }, () => finding) },
      missingFonts: [],
      missingLinks: [],
      modifiedLinks: [],
      oversetText: [],
      colorFindings: [],
      additionalChecks: {},
      truncation: { truncated: false, reasons: [], returnedItems: 500, totalItems: 500 },
    });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength)
      .toBeLessThan(MAX_BRIDGE_MESSAGE_BYTES - 256 * 1_024);
  });
});
