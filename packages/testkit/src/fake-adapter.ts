import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";
import {
  ApplyOperationsInputSchema,
  ApplyOperationsResultSchema,
  CreateDocumentInputSchema,
  CreateDocumentResultSchema,
  ExportDocumentInputSchema,
  ExportDocumentResultSchema,
  ExportPreviewBridgeResultSchema,
  ExportPreviewInputSchema,
  InspectItemsInputSchema,
  InspectItemsResultSchema,
  ListDocumentsInputSchema,
  ListDocumentsResultSchema,
  PluginStatusResultSchema,
  PreflightResultSchema,
  RunPreflightInputSchema,
  SaveCopyInputSchema,
  SaveCopyResultSchema,
  SelectionInputSchema,
  SelectionResultSchema,
  SnapshotInputSchema,
  SnapshotResultSchema,
  SolBridgeError,
  type BridgeMethod,
  type BridgeRequest,
  type InDesignObjectKind,
  type InDesignObjectRef,
  type Operation,
} from "@sol/protocol";
import { fixtureDocumentRef, fixtureItemRef, fixturePageRef } from "./fixtures.js";

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+HIwYAAAAAElFTkSuQmCC";

export interface BridgeDispatcher {
  dispatch(request: BridgeRequest): Promise<unknown>;
}

export interface FakeInDesignAdapterOptions {
  readonly delayMsByMethod?: Readonly<Partial<Record<BridgeMethod, number>>>;
  readonly transport?: "websocket" | "http";
}

function operationKind(operation: Operation): InDesignObjectKind {
  switch (operation.type) {
    case "ensure_layer": return "layer";
    case "create_page": return "page";
    case "create_rectangle": return "rectangle";
    case "create_oval": return "oval";
    case "create_text_frame": return "text_frame";
    case "create_or_update_color": return "color";
    case "create_or_update_paragraph_style": return "paragraph_style";
    case "create_or_update_object_style": return "object_style";
    case "group_items": return "group";
    case "place_file": return "graphic";
    case "set_text":
    case "set_item_bounds":
    case "set_item_appearance":
    case "apply_paragraph_style":
    case "apply_object_style":
    case "move_item_to_layer":
      return "rectangle";
  }
}

function formatMetadata(targetPath: string, format: "png" | "jpeg" | "pdf" | "idml" | "indd") {
  const mimeType = {
    png: "image/png",
    jpeg: "image/jpeg",
    pdf: "application/pdf",
    idml: "application/vnd.adobe.indesign-idml-package",
    indd: "application/x-indesign",
  }[format];
  return {
    workspacePath: targetPath,
    format,
    bytes: format === "png" ? 69 : 1_024,
    ...(format === "png" || format === "jpeg" ? { widthPx: 1, heightPx: 1 } : {}),
    mimeType,
  };
}

export class FakeInDesignAdapter implements BridgeDispatcher {
  readonly #options: FakeInDesignAdapterOptions;
  readonly requests: BridgeRequest[] = [];
  #revision = 1;
  #nextNativeId = 500;

  constructor(options: FakeInDesignAdapterOptions = {}) {
    this.#options = options;
  }

  get revision(): number {
    return this.#revision;
  }

  async dispatch(request: BridgeRequest): Promise<unknown> {
    this.requests.push(request);
    const delayMs = this.#options.delayMsByMethod?.[request.method] ?? 0;
    if (delayMs > 0) await delay(delayMs);

    switch (request.method) {
      case "indesign.status":
        return PluginStatusResultSchema.parse({
          pluginVersion: "0.1.0-test",
          inDesignVersion: "21.4.1-test",
          activeDocument: {
            documentRef: fixtureDocumentRef(this.#revision),
            modified: false,
            pageCount: 1,
          },
          workspaceAuthorized: true,
          queueDepth: 0,
          capabilities: {
            doScript: { status: "runtimeProbed", reason: "fake adapter" },
            preflight: { status: "runtimeProbed", reason: "fake adapter" },
          },
        });
      case "document.list": {
        ListDocumentsInputSchema.parse(request.params);
        return ListDocumentsResultSchema.parse({
          documents: [{
            documentRef: fixtureDocumentRef(this.#revision),
            active: true,
            modified: false,
            saved: false,
            pageCount: 1,
          }],
          truncation: { truncated: false, reasons: [], returnedItems: 1, totalItems: 1 },
        });
      }
      case "document.snapshot": {
        SnapshotInputSchema.parse(request.params);
        return SnapshotResultSchema.parse({
          documentRef: fixtureDocumentRef(this.#revision),
          revision: this.#revision,
          pages: [fixturePageRef()],
          layers: [{
            documentUuid: fixtureDocumentRef().documentUuid,
            nativeId: 210,
            kind: "layer",
            name: "Layer 1",
            fingerprint: "layer:210:Layer 1",
          }],
          items: [{
            objectRef: fixtureItemRef(),
            bounds: { x: 36, y: 36, width: 144, height: 72, unit: "pt" },
            childCount: 0,
          }],
          counts: { pages: 1, layers: 1, items: 1 },
          truncation: { truncated: false, reasons: [], returnedItems: 1, totalItems: 1 },
        });
      }
      case "document.selection": {
        SelectionInputSchema.parse(request.params);
        return SelectionResultSchema.parse({
          documentRef: fixtureDocumentRef(this.#revision),
          items: [],
          truncation: { truncated: false, reasons: [], returnedItems: 0, totalItems: 0 },
        });
      }
      case "document.inspectItems": {
        const input = InspectItemsInputSchema.parse(request.params);
        return InspectItemsResultSchema.parse({
          documentRef: fixtureDocumentRef(this.#revision),
          items: input.objectRefs.map((objectRef) => ({ objectRef })),
          missing: [],
        });
      }
      case "document.create": {
        const input = CreateDocumentInputSchema.parse(request.params);
        this.#revision = 1;
        const pageCount = input.pageCount;
        return CreateDocumentResultSchema.parse({
          documentRef: fixtureDocumentRef(this.#revision),
          revision: this.#revision,
          pages: Array.from({ length: pageCount }, (_, index) => ({
            ...fixturePageRef(),
            nativeId: 200 + index,
            name: String(index + 1),
            page: {
              documentUuid: fixtureDocumentRef().documentUuid,
              nativeId: 200 + index,
              name: String(index + 1),
            },
          })),
        });
      }
      case "document.applyOperations": {
        const input = ApplyOperationsInputSchema.parse(request.params);
        this.#assertRevision(input.expectedRevision, request.meta.traceId);
        const aliases: Record<string, InDesignObjectRef> = {};
        for (const operation of input.operations) {
          if (operation.ref !== undefined) {
            aliases[operation.ref] = fixtureItemRef(this.#nextNativeId, operationKind(operation));
            this.#nextNativeId += 1;
          }
        }
        if (!input.dryRun) this.#revision += 1;
        return ApplyOperationsResultSchema.parse({
          documentRef: fixtureDocumentRef(this.#revision),
          revision: this.#revision,
          dryRun: input.dryRun,
          validatedOperationCount: input.operations.length,
          completedOperationCount: input.dryRun ? 0 : input.operations.length,
          aliases,
          warnings: [],
          partialChanges: false,
          undoRecommended: false,
          undoLabel: input.dryRun ? null : `Sol MCP ${request.meta.traceId.slice(0, 8)}`,
        });
      }
      case "document.exportPreview": {
        const input = ExportPreviewInputSchema.parse(request.params);
        this.#assertRevision(input.expectedRevision, request.meta.traceId);
        return ExportPreviewBridgeResultSchema.parse({
          file: formatMetadata(input.targetPath, "png"),
          imageBase64: ONE_PIXEL_PNG_BASE64,
        });
      }
      case "document.saveCopy": {
        const input = SaveCopyInputSchema.parse(request.params);
        this.#assertRevision(input.expectedRevision, request.meta.traceId);
        return SaveCopyResultSchema.parse({ file: formatMetadata(input.targetPath, "indd") });
      }
      case "document.export": {
        const input = ExportDocumentInputSchema.parse(request.params);
        this.#assertRevision(input.expectedRevision, request.meta.traceId);
        return ExportDocumentResultSchema.parse({ files: [formatMetadata(input.targetPath, input.format)] });
      }
      case "document.preflight": {
        const input = RunPreflightInputSchema.parse(request.params);
        return PreflightResultSchema.parse({
          documentRef: fixtureDocumentRef(this.#revision),
          profileName: input.profileName ?? "[Basic]",
          passed: true,
          errorCount: 0,
          warningCount: null,
          warningCountAvailable: false,
          errorsByCategory: {},
          missingFonts: [],
          missingLinks: [],
          modifiedLinks: [],
          oversetText: [],
          colorFindings: [],
          additionalChecks: { source: "fake-adapter" },
          truncation: { truncated: false, reasons: [], returnedItems: 0, totalItems: 0 },
        });
      }
      default:
        return this.#assertNever(request.method);
    }
  }

  #assertRevision(expectedRevision: number, traceId: string): void {
    if (expectedRevision !== this.#revision) {
      throw new SolBridgeError({
        code: "STALE_DOCUMENT",
        message: "The fake document revision is stale.",
        traceId,
        retryable: true,
        details: { expectedRevision, actualRevision: this.#revision },
      });
    }
  }

  #assertNever(value: never): never {
    throw new z.ZodError([{
      code: "custom",
      input: value,
      path: ["method"],
      message: "Unsupported fake bridge method.",
    }]);
  }
}
