import { toPoints } from "@sol/domain";
import type { Bounds } from "@sol/domain";
import type { BridgeMethod, InDesignObjectRef, Operation } from "@sol/protocol";
import {
  AnchorPoint,
  BoundingBoxLimits,
  CoordinateSpaces,
  ExportFormat,
  ExportRangeOrAllPages,
  FontStatus,
  LinkStatus,
  PageRange,
  PNGExportRangeEnum,
  ScriptLanguage,
  UndoModes,
} from "indesign";
import { storage } from "uxp";
import type { UxpFile } from "uxp";
import { encodeStandardBase64 } from "../core/base64";
import { SafeBridgeError } from "../core/errors";
import {
  asRecord,
  callMember,
  collectionItems,
  getMember,
  hasMethod,
  readBoolean,
  readNumber,
  readString,
  safeText,
  setMember,
} from "../core/records";
import type { DiagnosticRing } from "../diagnostics/diagnostic-ring";
import { executeAsyncWithStrictFileEntryFallback } from "../security/dom-file-fallback";
import { validateWorkspaceRelativePath } from "../security/path-policy";
import type { WorkspaceManager } from "../security/workspace";
import { detectCapabilities } from "./capabilities";
import { scanBoundedCollection } from "./bounded-collection";
import { addVisibleDocument } from "./document-creation";
import {
  createUndoLabel,
  executeFunctionFormUndoGroup,
  requireUndoGroupingRuntime,
} from "./execution-context";
import type { AdapterExecutionContext } from "./execution-context";
import { assertSingleFilePdfPreset, assertSinglePageImageExport } from "./export-safety";
import { readNonEmptyFileSize } from "./file-metadata";
import {
  DOCUMENTED_BOTTOM_RIGHT_ANCHOR,
  DOCUMENTED_EXPORT_FORMAT_INDESIGN_MARKUP,
  DOCUMENTED_EXPORT_FORMAT_JPG,
  DOCUMENTED_EXPORT_FORMAT_PDF_TYPE,
  DOCUMENTED_EXPORT_FORMAT_PNG_FORMAT,
  DOCUMENTED_EXPORT_RANGE,
  DOCUMENTED_FONT_STATUS_NOT_AVAILABLE,
  DOCUMENTED_FONT_STATUS_SUBSTITUTED,
  DOCUMENTED_GEOMETRIC_PATH_BOUNDS,
  DOCUMENTED_LINK_STATUS_INACCESSIBLE,
  DOCUMENTED_LINK_STATUS_MISSING,
  DOCUMENTED_LINK_STATUS_OUT_OF_DATE,
  DOCUMENTED_PAGE_COORDINATES,
  DOCUMENTED_PAGE_RANGE_ALL_PAGES,
  DOCUMENTED_TOP_LEFT_ANCHOR,
  resolveDocumentedHostEnum,
} from "./host-enums";
import { IdentityRegistry } from "./identity";
import type { RevisionReservation } from "./identity";
import { pointMeasurement } from "./measurements";
import {
  createExecutionProgress,
  executePreparedOperations,
  prepareOperations,
} from "./operations";
import { resolvePageDimensions, resolvePageRelativeBounds } from "./page-geometry";
import { assertPreferencesReadable, createPreferenceGuard } from "./preference-guard";
import { parsePreflightResults, waitForPreflightCompletion } from "./preflight-results";
import { belongsToDocument } from "./selection-ownership";
import { collectSnapshotItems } from "./snapshot-traversal";
import { activeDocumentIfPresent, sameNativeDocument } from "./active-document";
import { readBinaryFile } from "./binary-file";
import { readBoundedTextSnippet } from "./text-snippet";
import type { DocumentRevisionStore } from "./revision-store";
import { LocalStorageDocumentRevisionStore } from "./revision-store";
import {
  isExactDocumentRedo,
  isExactDocumentUndo,
  resolutionErrorProvesObjectMissing,
  verifyUndoTrace,
} from "./undo-verification";
import type { UndoVerification } from "./undo-verification";
import { isApprovedUndoProofBatch } from "./undo-proof-candidate";

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const PAGE_GEOMETRY_ENUMS = {
  pageCoordinates: resolveDocumentedHostEnum(CoordinateSpaces.PAGE_COORDINATES, DOCUMENTED_PAGE_COORDINATES),
  topLeftAnchor: resolveDocumentedHostEnum(AnchorPoint.TOP_LEFT_ANCHOR, DOCUMENTED_TOP_LEFT_ANCHOR),
  bottomRightAnchor: resolveDocumentedHostEnum(AnchorPoint.BOTTOM_RIGHT_ANCHOR, DOCUMENTED_BOTTOM_RIGHT_ANCHOR),
  geometricPathBounds: resolveDocumentedHostEnum(
    BoundingBoxLimits.GEOMETRIC_PATH_BOUNDS,
    DOCUMENTED_GEOMETRIC_PATH_BOUNDS,
  ),
};
const EXPORT_FORMATS = {
  pdf: resolveDocumentedHostEnum(ExportFormat.PDF_TYPE, DOCUMENTED_EXPORT_FORMAT_PDF_TYPE),
  png: resolveDocumentedHostEnum(ExportFormat.PNG_FORMAT, DOCUMENTED_EXPORT_FORMAT_PNG_FORMAT),
  jpeg: resolveDocumentedHostEnum(ExportFormat.JPG, DOCUMENTED_EXPORT_FORMAT_JPG),
  idml: resolveDocumentedHostEnum(ExportFormat.INDESIGN_MARKUP, DOCUMENTED_EXPORT_FORMAT_INDESIGN_MARKUP),
};
const PNG_EXPORT_RANGE = resolveDocumentedHostEnum(
  PNGExportRangeEnum.EXPORT_RANGE,
  DOCUMENTED_EXPORT_RANGE,
);
const JPEG_EXPORT_RANGE = resolveDocumentedHostEnum(
  ExportRangeOrAllPages.EXPORT_RANGE,
  DOCUMENTED_EXPORT_RANGE,
);
const ALL_PAGES = resolveDocumentedHostEnum(PageRange.ALL_PAGES, DOCUMENTED_PAGE_RANGE_ALL_PAGES);
const FONT_STATUS_NOT_AVAILABLE = resolveDocumentedHostEnum(
  FontStatus.NOT_AVAILABLE,
  DOCUMENTED_FONT_STATUS_NOT_AVAILABLE,
);
const FONT_STATUS_SUBSTITUTED = resolveDocumentedHostEnum(
  FontStatus.SUBSTITUTED,
  DOCUMENTED_FONT_STATUS_SUBSTITUTED,
);
const LINK_STATUS_MISSING = resolveDocumentedHostEnum(
  LinkStatus.LINK_MISSING,
  DOCUMENTED_LINK_STATUS_MISSING,
);
const LINK_STATUS_INACCESSIBLE = resolveDocumentedHostEnum(
  LinkStatus.LINK_INACCESSIBLE,
  DOCUMENTED_LINK_STATUS_INACCESSIBLE,
);
const LINK_STATUS_OUT_OF_DATE = resolveDocumentedHostEnum(
  LinkStatus.LINK_OUT_OF_DATE,
  DOCUMENTED_LINK_STATUS_OUT_OF_DATE,
);

export interface AdapterStatusListener {
  onActiveDocument(documentName: string | undefined, revision: number | undefined): void;
}

interface UndoProofCandidate {
  readonly traceId: string;
  readonly documentUuid: string;
  readonly createdAliases: readonly InDesignObjectRef[];
  readonly approvedBatchShape: boolean;
  readonly preUndoObserved: boolean;
}

export class SolInDesignAdapter {
  readonly #application: unknown;
  readonly #workspace: WorkspaceManager;
  readonly #diagnostics: DiagnosticRing;
  readonly #identity: IdentityRegistry;
  readonly #statusListener: AdapterStatusListener | undefined;
  #groupingArraysProbed = false;
  #undoGroupingProbed = false;
  #undoProofCandidate: UndoProofCandidate | undefined;

  constructor(
    application: unknown,
    workspace: WorkspaceManager,
    diagnostics: DiagnosticRing,
    statusListener?: AdapterStatusListener,
    revisionStore: DocumentRevisionStore = new LocalStorageDocumentRevisionStore(),
  ) {
    this.#application = application;
    this.#workspace = workspace;
    this.#diagnostics = diagnostics;
    this.#statusListener = statusListener;
    this.#identity = new IdentityRegistry(revisionStore);
  }

  inDesignVersion(): string {
    return safeText(getMember(this.#application, "version"), "unknown") || "unknown";
  }

  capabilities(): ReturnType<typeof detectCapabilities> {
    return detectCapabilities(this.#application, {
      scriptLanguage: ScriptLanguage.UXPSCRIPT,
      undoMode: UndoModes.ENTIRE_SCRIPT,
      groupingArraysProbed: this.#groupingArraysProbed,
      undoGroupingProbed: this.#undoGroupingProbed,
    });
  }

  activeDocumentSummary(): Record<string, unknown> | null {
    const document = activeDocumentIfPresent(this.#application);
    if (!isValid(document)) return null;
    const documentRef = this.#identity.documentRef(document);
    this.#statusListener?.onActiveDocument(documentRef.name, documentRef.revision);
    return {
      documentRef,
      modified: getMember(document, "modified") === true,
      pageCount: collectionItems(getMember(document, "pages"), 10_000).length,
    };
  }

  async execute(method: BridgeMethod, input: unknown, context?: AdapterExecutionContext): Promise<unknown> {
    switch (method) {
      case "indesign.status": return this.#status();
      case "document.list": return this.#listDocuments(input);
      case "document.snapshot": return this.#snapshot(input);
      case "document.selection": return this.#selection(input);
      case "document.inspectItems": return this.#inspectItems(input);
      case "document.create": return this.#createDocument(input);
      case "document.applyOperations": {
        if (context === undefined) {
          throw new SafeBridgeError("INVALID_INPUT", "Operation execution context is required.");
        }
        return this.#applyOperations(input, context);
      }
      case "document.exportPreview": return this.#exportPreview(input);
      case "document.saveCopy": return this.#saveCopy(input);
      case "document.export": return this.#exportDocument(input);
      case "document.preflight": return this.#runPreflight(input);
    }
  }

  #status(): Record<string, unknown> {
    return {
      pluginVersion: __SOL_PLUGIN_VERSION__,
      inDesignVersion: this.inDesignVersion(),
      activeDocument: this.activeDocumentSummary(),
      workspaceAuthorized: this.#workspace.status().authorized,
      capabilities: this.capabilities(),
    };
  }

  #listDocuments(input: unknown): Record<string, unknown> {
    const request = asRecord(input, "list documents input");
    const maxDocuments = readNumber(request, "maxDocuments", { min: 1, max: 200, integer: true }) ?? 50;
    const all = collectionItems(getMember(this.#application, "documents"), 201);
    const active = all.length === 0 ? undefined : activeDocumentIfPresent(this.#application);
    const documents = all.slice(0, maxDocuments).map((document) => ({
      documentRef: this.#identity.documentRef(document),
      active: sameNativeDocument(document, active),
      modified: getMember(document, "modified") === true,
      saved: getMember(document, "saved") === true,
      pageCount: collectionItems(getMember(document, "pages"), 10_000).length,
    }));
    return {
      documents,
      truncation: truncation(all.length > maxDocuments, documents.length, all.length > 200 ? undefined : all.length, "Document limit reached."),
    };
  }

  #snapshot(input: unknown): Record<string, unknown> {
    const request = asRecord(input, "snapshot input");
    const document = this.#identity.resolveDocument(this.#application, request.documentRef);
    const maxDepth = readNumber(request, "maxDepth", { min: 0, max: 8, integer: true }) ?? 3;
    const maxItems = readNumber(request, "maxItems", { min: 1, max: 2_000, integer: true }) ?? 500;
    const includeText = readBoolean(request, "includeTextSnippets", false);
    const includeStyles = readBoolean(request, "includeStyles", false);
    const includeLinks = readBoolean(request, "includeLinks", false);
    const includeWarnings = readBoolean(request, "includeWarnings", false);
    const expectedUndoTraceId = readString(request, "expectedUndoTraceId", { max: 100 });
    const pageItems = collectionItems(getMember(document, "pageItems"), 2_001);
    const traversal = collectSnapshotItems(pageItems, maxDepth, maxItems);
    const items = traversal.items.map((item) => this.#snapshotItem(document, item, includeText, includeStyles, includeLinks));
    const pages = collectionItems(getMember(document, "pages"), 2_000).map((item) => this.#identity.objectRef(document, item));
    const layers = collectionItems(getMember(document, "layers"), 2_000).map((item) => this.#identity.objectRef(document, item));
    const styleNames = includeStyles ? [
      ...collectionItems(getMember(document, "paragraphStyles"), 1_000),
      ...collectionItems(getMember(document, "objectStyles"), 1_000),
    ].map((style) => safeText(getMember(style, "name"))).filter((name) => name.length > 0).slice(0, 2_000) : undefined;
    const links = includeLinks ? collectionItems(getMember(document, "links"), 2_000)
      .map((link) => safeText(getMember(link, "name")))
      .filter((name) => name.length > 0) : undefined;
    const warnings = includeWarnings ? collectDocumentWarnings(document) : undefined;
    const documentRef = this.#identity.documentRef(document);
    const undoVerification = expectedUndoTraceId === undefined
      ? undefined
      : this.#verifyUndoProof(document, documentRef, expectedUndoTraceId);
    return {
      documentRef,
      revision: documentRef.revision,
      pages,
      layers,
      items,
      counts: {
        pages: pages.length,
        layers: layers.length,
        items: traversal.total,
        stories: collectionItems(getMember(document, "stories"), 100_000).length,
        links: collectionItems(getMember(document, "links"), 100_000).length,
      },
      ...(styleNames === undefined ? {} : { styles: styleNames }),
      ...(links === undefined ? {} : { links }),
      ...(warnings === undefined ? {} : { warnings }),
      ...(undoVerification === undefined ? {} : { undoVerification }),
      truncation: truncation(
        traversal.truncated || pageItems.length > 2_000,
        items.length,
        pageItems.length > 2_000 ? undefined : traversal.total,
        "Item depth or item limit reached.",
      ),
    };
  }

  #selection(input: unknown): Record<string, unknown> {
    const request = asRecord(input, "selection input");
    const document = this.#identity.resolveDocument(this.#application, request.documentRef);
    const maxItems = readNumber(request, "maxItems", { min: 1, max: 100, integer: true }) ?? 100;
    const includeText = readBoolean(request, "includeTextSnippets", false);
    const selected = collectionItems(getMember(this.#application, "selection"), 101)
      .filter((item) => belongsToDocument(item, document));
    const items = selected.slice(0, maxItems).map((item) => this.#snapshotItem(document, item, includeText, false, false));
    return {
      documentRef: this.#identity.documentRef(document),
      items,
      truncation: truncation(selected.length > maxItems, items.length, selected.length > 100 ? undefined : selected.length, "Selection limit reached."),
    };
  }

  #inspectItems(input: unknown): Record<string, unknown> {
    const request = asRecord(input, "inspect items input");
    const document = this.#identity.resolveDocument(this.#application, request.documentRef);
    const references = request.objectRefs;
    if (!Array.isArray(references) || references.length === 0 || references.length > 100) {
      throw new SafeBridgeError("INVALID_INPUT", "objectRefs must contain between 1 and 100 references.");
    }
    const includeText = readBoolean(request, "includeTextSnippets", false);
    const includeStyles = readBoolean(request, "includeStyles", false);
    const includeLinks = readBoolean(request, "includeLinks", false);
    const items: Record<string, unknown>[] = [];
    const missing: unknown[] = [];
    for (const reference of references) {
      try {
        const item = this.#identity.resolveObject(document, reference);
        items.push(this.#snapshotItem(document, item, includeText, includeStyles, includeLinks));
      } catch (error) {
        if (error instanceof SafeBridgeError && (error.code === "ITEM_NOT_FOUND" || error.code === "STALE_OBJECT")) missing.push(reference);
        else throw error;
      }
    }
    return { documentRef: this.#identity.documentRef(document), items, missing };
  }

  #createDocument(input: unknown): Record<string, unknown> {
    const request = asRecord(input, "create document input");
    const documents = getMember(this.#application, "documents");
    if (documents === undefined || !hasMethod(documents, "add")) {
      throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "This InDesign runtime cannot create documents.");
    }
    const pageCount = readNumber(request, "pageCount", { min: 1, max: 100, integer: true }) ?? 1;
    const facingPages = readBoolean(request, "facingPages", false);
    const orientation = readString(request, "orientation") ?? "portrait";
    const size = resolvePageSize(request.pageSize, orientation);
    const document = addVisibleDocument(documents);
    try {
      if (getMember(document, "visible") !== true) {
        throw new SafeBridgeError(
          "UNSUPPORTED_CAPABILITY",
          "InDesign created the document without a visible document window.",
        );
      }
      // Creating the document is already a mutation. Persist its identity before
      // applying settings so any later partial failure remains addressable.
      this.#identity.documentRef(document, true);
      this.#identity.persistCurrentRevision(document);
      const preferences = getMember(document, "documentPreferences");
      setMember(preferences, "pageWidth", pointMeasurement(size.width));
      setMember(preferences, "pageHeight", pointMeasurement(size.height));
      setMember(preferences, "facingPages", facingPages);
      const pages = getMember(document, "pages");
      while (collectionItems(pages, 101).length < pageCount) callMember(pages, "add");
      applyMargins(document, request.margins);
      applyBleed(preferences, request.bleed);
      const documentRef = this.#identity.documentRef(document, true);
      this.#statusListener?.onActiveDocument(documentRef.name, documentRef.revision);
      return {
        documentRef,
        revision: 1,
        pages: collectionItems(getMember(document, "pages"), 100).map((page) => this.#identity.objectRef(document, page, true)),
      };
    } catch (error) {
      this.#diagnostics.add("error", "document.create.failed", { code: error instanceof SafeBridgeError ? error.code : "DOM_ERROR" });
      let documentRef: ReturnType<IdentityRegistry["documentRef"]> | undefined;
      try {
        documentRef = this.#identity.documentRef(document);
      } catch {
        documentRef = undefined;
      }
      throw new SafeBridgeError(
        "PARTIAL_FAILURE",
        "InDesign created the document but could not finish applying the requested settings.",
        {
          details: {
            partialChanges: true,
            revision: documentRef?.revision ?? 1,
            ...(documentRef === undefined ? {} : { documentRef }),
          },
        },
      );
    }
  }

  async #applyOperations(input: unknown, context: AdapterExecutionContext): Promise<Record<string, unknown>> {
    const request = asRecord(input, "apply operations input");
    const undoLabel = createUndoLabel(context);
    const document = this.#identity.resolveDocument(this.#application, request.documentRef);
    const expectedRevision = readNumber(request, "expectedRevision", { required: true, min: 0, integer: true });
    if (expectedRevision === undefined) throw new SafeBridgeError("INVALID_INPUT", "expectedRevision is required.");
    this.#identity.assertRevision(document, expectedRevision);
    if (!Array.isArray(request.operations) || request.operations.length === 0 || request.operations.length > 100) {
      throw new SafeBridgeError("INVALID_INPUT", "operations must contain between 1 and 100 operations.");
    }
    const operations = request.operations as Operation[];
    const dryRun = readBoolean(request, "dryRun", false);
    const plan = await prepareOperations(document, operations, this.#identity, this.#workspace);
    const undoRuntime = requireUndoGroupingRuntime(
      hasMethod(this.#application, "doScript"),
      ScriptLanguage.UXPSCRIPT,
      UndoModes.ENTIRE_SCRIPT,
    );
    if (dryRun) {
      return {
        documentRef: this.#identity.documentRef(document),
        revision: this.#identity.revision(document),
        dryRun: true,
        validatedOperationCount: operations.length,
        completedOperationCount: 0,
        aliases: {},
        warnings: [...plan.warnings],
        partialChanges: false,
        undoRecommended: false,
        undoLabel: null,
      };
    }

    const progress = createExecutionProgress();
    const requiresDocumentIdentityWrite = !this.#identity.documentRef(document).identityPersistent;
    const revisionReservation = this.#identity.reserveRevision(document);
    try {
      await executeFunctionFormUndoGroup(this.#application, undoRuntime, undoLabel, () => {
        if (requiresDocumentIdentityWrite) progress.mutationStarted = true;
        this.#identity.documentRef(document, true);
        executePreparedOperations(document, plan, this.#identity, this.#workspace, progress);
      });
      if (progress.completed !== operations.length) {
        throw new SafeBridgeError(
          "UXP_OPERATION_FAILED",
          "InDesign completed the Undo group without confirming every validated operation.",
          {
            details: {
              completedOperationCount: progress.completed,
              aliases: progress.aliases,
              partialChanges: progress.mutationStarted,
            },
          },
        );
      }
      const undoObservation = verifyUndoTrace(this.#application, document, context.traceId);
      if (!isExactDocumentUndo(undoObservation)) {
        throw new SafeBridgeError(
          "UNSUPPORTED_CAPABILITY",
          "InDesign did not expose the completed batch as the exact top Undo action on the explicit document.",
          {
            details: {
              completedOperationCount: progress.completed,
              aliases: progress.aliases,
              partialChanges: true,
              failedStage: "undo.label",
            },
          },
        );
      }
      if (operations.some((operation) => operation.type === "group_items")) {
        this.#groupingArraysProbed = true;
      }
      const revision = this.#identity.commitRevision(revisionReservation);
      const documentRef = this.#identity.documentRef(document);
      this.#undoProofCandidate = {
        traceId: context.traceId,
        documentUuid: documentRef.documentUuid,
        createdAliases: createdAliasReferences(operations, progress.aliases),
        approvedBatchShape: isApprovedUndoProofBatch(operations, progress.aliases),
        preUndoObserved: true,
      };
      return {
        documentRef,
        revision,
        dryRun: false,
        validatedOperationCount: operations.length,
        completedOperationCount: progress.completed,
        aliases: progress.aliases,
        warnings: [...plan.warnings],
        partialChanges: false,
        undoRecommended: false,
        undoLabel,
      };
    } catch (error) {
      const details = error instanceof SafeBridgeError ? error.details : undefined;
      const completed = typeof details?.completedOperationCount === "number"
        ? details.completedOperationCount
        : progress.completed;
      const aliases = typeof details?.aliases === "object" && details.aliases !== null
        ? details.aliases
        : progress.aliases;
      const partialChanges = details?.partialChanges === true || progress.mutationStarted;
      const failedOperationIndex = typeof details?.failedOperationIndex === "number"
        ? details.failedOperationIndex
        : undefined;
      const failedOperationType = typeof details?.failedOperationType === "string"
        ? details.failedOperationType
        : undefined;
      const failureCode = typeof details?.failureCode === "string"
        ? details.failureCode
        : undefined;
      const failedStage = safeFailureToken(details?.failedStage);
      const argumentForm = safeFailureToken(details?.argumentForm);
      const failureReason = safeFailureToken(details?.failureReason);
      if (!partialChanges) {
        this.#rollbackRevisionReservation(revisionReservation);
        throw error;
      }
      const revision = this.#identity.commitRevision(revisionReservation);
      const documentRef = this.#identity.documentRef(document);
      throw new SafeBridgeError(
        "PARTIAL_FAILURE",
        "InDesign stopped the batch after a DOM error; use the reported Undo label after reviewing the document.",
        {
          details: {
            documentRef,
            revision,
            validatedOperationCount: operations.length,
            completedOperationCount: completed,
            ...(failedOperationIndex === undefined ? {} : { failedOperationIndex }),
            ...(failedOperationType === undefined ? {} : { failedOperationType }),
            ...(failureCode === undefined ? {} : { failureCode }),
            ...(failedStage === undefined ? {} : { failedStage }),
            ...(argumentForm === undefined ? {} : { argumentForm }),
            ...(failureReason === undefined ? {} : { failureReason }),
            aliases,
            partialChanges: true,
            undoRecommended: true,
            undoLabel,
          },
        },
      );
    }
  }

  #rollbackRevisionReservation(reservation: RevisionReservation): void {
    try {
      this.#identity.rollbackRevision(reservation);
    } catch {
      const revision = this.#identity.commitRevision(reservation);
      this.#diagnostics.add("warning", "document.revision-rollback.failed", { revision });
    }
  }

  #verifyUndoProof(
    document: unknown,
    documentRef: ReturnType<IdentityRegistry["documentRef"]>,
    traceId: string,
  ): UndoVerification & { readonly createdAliasesMissing: boolean | null; readonly proofComplete: boolean } {
    const observation = verifyUndoTrace(this.#application, document, traceId);
    const candidate = this.#undoProofCandidate;
    const candidateMatches = candidate?.traceId === traceId
      && candidate.documentUuid === documentRef.documentUuid;
    const createdAliasesMissing = candidateMatches && candidate.createdAliases.length > 0
      ? candidate.createdAliases.every((reference) => this.#objectReferenceIsMissing(document, reference))
      : null;
    const proofComplete = candidateMatches
      && candidate.preUndoObserved
      && candidate.approvedBatchShape
      && isExactDocumentRedo(observation)
      && createdAliasesMissing === true;
    if (proofComplete) this.#undoGroupingProbed = true;
    return { ...observation, createdAliasesMissing, proofComplete };
  }

  #objectReferenceIsMissing(document: unknown, reference: InDesignObjectRef): boolean {
    try {
      this.#identity.resolveObject(document, reference);
      return false;
    } catch (error: unknown) {
      if (resolutionErrorProvesObjectMissing(error)) return true;
      if (error instanceof SafeBridgeError && error.code === "STALE_OBJECT") return false;
      throw error;
    }
  }

  async #exportPreview(input: unknown): Promise<Record<string, unknown>> {
    const request = asRecord(input, "export preview input");
    const document = this.#documentAtRevision(request);
    const targetPath = readString(request, "targetPath", { required: true, max: 1_024 });
    if (targetPath === undefined || !/^previews\/.+\.png$/iu.test(targetPath)) {
      throw new SafeBridgeError("PATH_NOT_ALLOWED", "Preview output must be a PNG below previews/.");
    }
    validateWorkspaceRelativePath(targetPath);
    const maxDimension = readNumber(request, "maxDimensionPx", { min: 256, max: 2_048, integer: true }) ?? 1_600;
    const overwrite = readBoolean(request, "overwrite", false);
    assertPageReference(request.pageRef, "pageRef");
    const page = this.#identity.resolveObject(document, request.pageRef);
    const pageName = requiredUniqueExportPageName(document, page);
    const dimensions = resolvePageDimensions(page, PAGE_GEOMETRY_ENUMS);
    const widthPt = dimensions.width;
    const heightPt = dimensions.height;
    if (widthPt <= 0 || heightPt <= 0) {
      throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign returned invalid page dimensions for preview export.");
    }
    const exportRange = PNG_EXPORT_RANGE;
    const domFormat = EXPORT_FORMATS.png;
    const preferences = getMember(this.#application, "pngExportPreferences");
    const guard = createPreferenceGuard(preferences, ["exportResolution", "pageString", "pngExportRange", "exportingSpread"]);
    const file = await this.#workspace.resolveOutput(targetPath, overwrite);
    let dpi = clamp(Math.floor(maxDimension * 72 / Math.max(widthPt, heightPt)), 1, 2_400);
    let binary: Uint8Array = new Uint8Array();
    try {
      setMember(preferences, "pageString", pageName);
      setMember(preferences, "pngExportRange", exportRange);
      setMember(preferences, "exportingSpread", false);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        setMember(preferences, "exportResolution", dpi);
        await this.#exportFile(document, domFormat, file, []);
        binary = await readBinaryFile(file, storage.formats.binary);
        if (binary.byteLength <= MAX_PREVIEW_BYTES) break;
        dpi = Math.max(1, Math.floor(dpi * 0.72));
      }
    } finally {
      guard.restore();
    }
    if (binary.byteLength > MAX_PREVIEW_BYTES) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", "Preview remains larger than 4 MiB after bounded resolution retries.");
    }
    const fileSize = await readNonEmptyFileSize(file);
    if (fileSize !== binary.byteLength) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", "Preview metadata did not match the exported file bytes.");
    }
    const widthPx = Math.max(1, Math.round(widthPt * dpi / 72));
    const heightPx = Math.max(1, Math.round(heightPt * dpi / 72));
    return {
      file: fileMetadata(targetPath, "png", binary.byteLength, "image/png", widthPx, heightPx),
      imageBase64: encodeStandardBase64(binary),
    };
  }

  async #saveCopy(input: unknown): Promise<Record<string, unknown>> {
    const request = asRecord(input, "save copy input");
    const document = this.#documentAtRevision(request);
    const targetPath = requiredOutputPath(request, ".indd");
    const file = await this.#workspace.resolveOutput(targetPath, readBoolean(request, "overwrite", false));
    await executeAsyncWithStrictFileEntryFallback(
      file,
      () => this.#workspace.nativePathForDom(file),
      (domFile) => callMember(document, "saveACopy", [domFile]),
    );
    const bytes = await readNonEmptyFileSize(file);
    return { file: fileMetadata(targetPath, "indd", bytes, "application/x-indesign") };
  }

  async #exportDocument(input: unknown): Promise<Record<string, unknown>> {
    const request = asRecord(input, "export document input");
    const document = this.#documentAtRevision(request);
    const format = readString(request, "format", { required: true });
    if (format !== "pdf" && format !== "png" && format !== "jpeg" && format !== "idml") {
      throw new SafeBridgeError("INVALID_INPUT", "format must be pdf, png, jpeg, or idml.");
    }
    const extension = format === "jpeg" ? ".jpg" : `.${format}`;
    const targetPath = requiredOutputPath(request, extension, format === "jpeg" ? [".jpeg"] : []);
    const pageRefs = request.pageRefs;
    if (pageRefs !== undefined && !Array.isArray(pageRefs)) throw new SafeBridgeError("INVALID_INPUT", "pageRefs must be an array.");
    if (Array.isArray(pageRefs) && (pageRefs.length === 0 || pageRefs.length > 1_000)) {
      throw new SafeBridgeError("INVALID_INPUT", "pageRefs must contain between 1 and 1000 page references.");
    }
    if (format === "png" || format === "jpeg") assertSinglePageImageExport(format, pageRefs?.length ?? 0);
    const pageNames: string[] = [];
    for (const [index, reference] of (pageRefs ?? []).entries()) {
      assertPageReference(reference, `pageRefs[${index}]`);
      pageNames.push(requiredUniqueExportPageName(document, this.#identity.resolveObject(document, reference)));
    }

    let domFormat: unknown;
    let mimeType: string;
    let preset: unknown;
    if (format === "pdf") {
      const presetName = readString(request, "pdfPresetName", { required: true, max: 255 });
      preset = presetName === undefined ? undefined : findNamed(getMember(this.#application, "pdfExportPresets"), presetName);
      if (!isValid(preset)) throw new SafeBridgeError("PRESET_NOT_FOUND", `PDF preset '${presetName ?? ""}' was not found.`);
      assertSingleFilePdfPreset(getMember(preset, "exportAsSinglePages"));
      domFormat = EXPORT_FORMATS.pdf;
      mimeType = "application/pdf";
    } else if (format === "png") {
      domFormat = EXPORT_FORMATS.png;
      mimeType = "image/png";
    } else if (format === "jpeg") {
      domFormat = EXPORT_FORMATS.jpeg;
      mimeType = "image/jpeg";
    } else {
      domFormat = EXPORT_FORMATS.idml;
      mimeType = "application/vnd.adobe.indesign-idml-package";
    }

    if (format === "pdf") {
      assertPreferencesReadable(getMember(this.#application, "pdfExportPreferences"), ["pageRange", "exportAsSinglePages", "viewPDF"]);
    } else if (format === "png") {
      assertPreferencesReadable(getMember(this.#application, "pngExportPreferences"), ["pageString", "pngExportRange", "exportingSpread"]);
    } else if (format === "jpeg") {
      assertPreferencesReadable(getMember(this.#application, "jpegExportPreferences"), ["pageString", "jpegExportRange", "exportingSpread"]);
    }

    const file = await this.#workspace.resolveOutput(targetPath, readBoolean(request, "overwrite", false));
    if (format === "pdf") {
      const preferences = getMember(this.#application, "pdfExportPreferences");
      const guard = createPreferenceGuard(preferences, ["pageRange", "exportAsSinglePages", "viewPDF"]);
      const pageRange = pageNames.length === 0
        ? ALL_PAGES
        : pageNames.join(",");
      try {
        setMember(preferences, "pageRange", pageRange);
        setMember(preferences, "exportAsSinglePages", false);
        setMember(preferences, "viewPDF", false);
        await this.#exportFile(document, domFormat, file, [false, preset]);
      } finally {
        guard.restore();
      }
    } else if (format === "png") {
      const preferences = getMember(this.#application, "pngExportPreferences");
      const guard = createPreferenceGuard(preferences, ["pageString", "pngExportRange", "exportingSpread"]);
      const exportRange = PNG_EXPORT_RANGE;
      try {
        setMember(preferences, "pageString", pageNames[0]);
        setMember(preferences, "pngExportRange", exportRange);
        setMember(preferences, "exportingSpread", false);
        await this.#exportFile(document, domFormat, file, []);
      } finally {
        guard.restore();
      }
    } else if (format === "jpeg") {
      const preferences = getMember(this.#application, "jpegExportPreferences");
      const guard = createPreferenceGuard(preferences, ["pageString", "jpegExportRange", "exportingSpread"]);
      const exportRange = JPEG_EXPORT_RANGE;
      try {
        setMember(preferences, "pageString", pageNames[0]);
        setMember(preferences, "jpegExportRange", exportRange);
        setMember(preferences, "exportingSpread", false);
        await this.#exportFile(document, domFormat, file, []);
      } finally {
        guard.restore();
      }
    } else {
      await this.#exportFile(document, domFormat, file, []);
    }
    const bytes = await readNonEmptyFileSize(file);
    return { files: [fileMetadata(targetPath, format, bytes, mimeType)] };
  }

  async #runPreflight(input: unknown): Promise<Record<string, unknown>> {
    const request = asRecord(input, "preflight input");
    const document = this.#identity.resolveDocument(this.#application, request.documentRef);
    const maxFindings = readNumber(request, "maxFindings", { min: 1, max: 500, integer: true }) ?? 500;
    const profileName = readString(request, "profileName", { max: 255 }) ?? "[Basic]";
    const profiles = getMember(this.#application, "preflightProfiles");
    const profile = findNamed(profiles, profileName);
    if (!isValid(profile)) throw new SafeBridgeError("PRESET_NOT_FOUND", `Preflight profile '${profileName}' was not found.`);
    const processes = getMember(this.#application, "preflightProcesses");
    if (processes === undefined || !hasMethod(processes, "add")) {
      throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "This InDesign runtime does not expose preflight processes.");
    }
    const process = await callMember(processes, "add", [document, profile]);
    const removable = hasMethod(process, "remove");
    try {
      if (!removable || !hasMethod(process, "waitForProcess")) {
        throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "This InDesign runtime cannot wait for and clean up a preflight process safely.");
      }
      await waitForPreflightCompletion((waitTimeSeconds) => (
        callMember(process, "waitForProcess", [waitTimeSeconds])
      ));
      const findings = parsePreflightResults(getMember(process, "aggregatedResults"), maxFindings);
      const checks = additionalChecks(
        document,
        this.#identity,
        Math.max(0, maxFindings - findings.totalReturned),
      );
      const returnedItems = findings.totalReturned
        + checks.missingFonts.length
        + checks.missingLinks.length
        + checks.modifiedLinks.length
        + checks.oversetText.length;
      const preflightTruncated = findings.truncated || checks.truncated;
      return {
        documentRef: this.#identity.documentRef(document),
        profileName,
        passed: findings.total === 0 && checks.totalFindings === 0 && checks.scanComplete,
        errorCount: findings.total,
        warningCount: null,
        warningCountAvailable: false,
        errorsByCategory: findings.byCategory,
        missingFonts: checks.missingFonts,
        missingLinks: checks.missingLinks,
        modifiedLinks: checks.modifiedLinks,
        oversetText: checks.oversetText,
        colorFindings: findings.colorFindings,
        additionalChecks: {
          missingFonts: checks.counts.missingFonts,
          missingLinks: checks.counts.missingLinks,
          modifiedLinks: checks.counts.modifiedLinks,
          oversetText: checks.counts.oversetText,
          scanComplete: checks.scanComplete,
        },
        truncation: {
          truncated: preflightTruncated,
          reasons: [
            ...(findings.truncated ? ["Preflight profile finding limit reached."] : []),
            ...(checks.truncated ? ["Additional checks were bounded or could not be represented completely."] : []),
          ],
          returnedItems,
          ...(checks.scanComplete ? { totalItems: findings.total + checks.totalFindings } : {}),
        },
      };
    } finally {
      if (removable) await callMember(process, "remove");
    }
  }

  #documentAtRevision(request: Record<string, unknown>): unknown {
    const document = this.#identity.resolveDocument(this.#application, request.documentRef);
    const expected = readNumber(request, "expectedRevision", { required: true, min: 0, integer: true });
    if (expected === undefined) throw new SafeBridgeError("INVALID_INPUT", "expectedRevision is required.");
    this.#identity.assertRevision(document, expected);
    return document;
  }

  #snapshotItem(document: unknown, item: unknown, includeText: boolean, includeStyles: boolean, includeLinks: boolean): Record<string, unknown> {
    const detailItem = this.#identity.typedProxy(document, item);
    const objectRef = this.#identity.objectRef(document, detailItem);
    const bounds = optionalBounds(detailItem);
    const contents = includeText
      ? readBoundedTextSnippet(detailItem, objectRef.kind, 500)
      : "";
    const styleNames = includeStyles ? [
      safeText(getMember(getMember(detailItem, "appliedObjectStyle"), "name")),
      safeText(getMember(getMember(detailItem, "appliedParagraphStyle"), "name")),
    ].filter((name) => name.length > 0) : undefined;
    const link = includeLinks ? safeText(getMember(getMember(detailItem, "itemLink"), "status")) : "";
    return {
      objectRef,
      ...(bounds === undefined ? {} : { bounds }),
      ...(includeText && contents.length > 0 ? { textSnippet: contents } : {}),
      childCount: collectionItems(getMember(detailItem, "pageItems"), 10_000).length,
      ...(styleNames === undefined ? {} : { styleNames }),
      ...(includeLinks && link.length > 0 ? { linkStatus: link } : {}),
    };
  }

  async #exportFile(document: unknown, format: unknown, file: UxpFile, extraArgs: readonly unknown[]): Promise<void> {
    await executeAsyncWithStrictFileEntryFallback(
      file,
      () => this.#workspace.nativePathForDom(file),
      (domFile) => callMember(document, "exportFile", [format, domFile, ...extraArgs]),
    );
  }
}

function resolvePageSize(value: unknown, orientation: string): { width: number; height: number } {
  let width = 595.275590551;
  let height = 841.88976378;
  if (typeof value === "object" && value !== null && !("preset" in value)) {
    const record = value as Record<string, unknown>;
    const unit = record.unit;
    if (unit !== "pt" && unit !== "mm" && unit !== "cm" && unit !== "in" && unit !== "px") {
      throw new SafeBridgeError("INVALID_INPUT", "Custom page size has an unsupported unit.");
    }
    if (typeof record.width !== "number" || typeof record.height !== "number") {
      throw new SafeBridgeError("INVALID_INPUT", "Custom page size requires width and height.");
    }
    width = toPoints(record.width, unit);
    height = toPoints(record.height, unit);
  }
  const portrait = orientation !== "landscape";
  return portrait
    ? { width: Math.min(width, height), height: Math.max(width, height) }
    : { width: Math.max(width, height), height: Math.min(width, height) };
}

function applyMargins(document: unknown, value: unknown): void {
  if (value === undefined) return;
  const record = asRecord(value, "margins");
  const unit = measurementUnit(record);
  for (const page of collectionItems(getMember(document, "pages"), 100)) {
    const preferences = getMember(page, "marginPreferences");
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const amount = readNumber(record, side, { required: true, min: 0 });
      if (amount !== undefined) setMember(preferences, side, pointMeasurement(toPoints(amount, unit)));
    }
  }
}

function applyBleed(preferences: unknown, value: unknown): void {
  if (value === undefined) return;
  const record = asRecord(value, "bleed");
  const unit = measurementUnit(record);
  setMember(preferences, "documentBleedUniformSize", false);
  const map = { top: "documentBleedTopOffset", right: "documentBleedOutsideOrRightOffset", bottom: "documentBleedBottomOffset", left: "documentBleedInsideOrLeftOffset" } as const;
  for (const [side, property] of Object.entries(map)) {
    const amount = readNumber(record, side, { required: true, min: 0 });
    if (amount !== undefined) setMember(preferences, property, pointMeasurement(toPoints(amount, unit)));
  }
}

function measurementUnit(record: Record<string, unknown>): "pt" | "mm" | "cm" | "in" | "px" {
  const value = record.unit;
  if (value === "pt" || value === "mm" || value === "cm" || value === "in" || value === "px") return value;
  throw new SafeBridgeError("INVALID_INPUT", "Measurement unit is invalid.");
}

function optionalBounds(item: unknown): Bounds | undefined {
  try {
    return resolvePageRelativeBounds(item, PAGE_GEOMETRY_ENUMS);
  } catch {
    return undefined;
  }
}

function fileMetadata(
  workspacePath: string,
  format: "png" | "jpeg" | "pdf" | "idml" | "indd",
  bytes: number,
  mimeType: string,
  widthPx?: number,
  heightPx?: number,
): Record<string, unknown> {
  return {
    workspacePath,
    format,
    bytes,
    mimeType,
    ...(widthPx === undefined ? {} : { widthPx }),
    ...(heightPx === undefined ? {} : { heightPx }),
  };
}

function requiredOutputPath(request: Record<string, unknown>, extension: string, alternatives: readonly string[] = []): string {
  const value = readString(request, "targetPath", { required: true, max: 1_024 });
  if (value === undefined) throw new SafeBridgeError("INVALID_INPUT", "targetPath is required.");
  validateWorkspaceRelativePath(value);
  const lower = value.toLowerCase();
  if (!lower.endsWith(extension) && !alternatives.some((candidate) => lower.endsWith(candidate))) {
    throw new SafeBridgeError("PATH_NOT_ALLOWED", `The output path must use ${extension}.`);
  }
  return value;
}

function findNamed(collection: unknown, name: string): unknown {
  if (collection === undefined) return undefined;
  if (hasMethod(collection, "itemByName")) {
    try {
      const item = callMember(collection, "itemByName", [name]);
      if (isValid(item)) return item;
    } catch {
      return undefined;
    }
  }
  return collectionItems(collection).find((item) => getMember(item, "name") === name);
}

function additionalChecks(document: unknown, identity: IdentityRegistry, maxResults: number): {
  missingFonts: string[];
  missingLinks: string[];
  modifiedLinks: string[];
  oversetText: InDesignObjectRef[];
  counts: { missingFonts: number; missingLinks: number; modifiedLinks: number; oversetText: number };
  totalFindings: number;
  scanComplete: boolean;
  truncated: boolean;
} {
  const missingFontStatuses: ReadonlySet<unknown> = new Set([
    FONT_STATUS_NOT_AVAILABLE,
    FONT_STATUS_SUBSTITUTED,
  ]);
  const missingLinkStatuses: ReadonlySet<unknown> = new Set([
    LINK_STATUS_MISSING,
    LINK_STATUS_INACCESSIBLE,
  ]);
  const modifiedLinkStatus = LINK_STATUS_OUT_OF_DATE;
  const fontScan = scanBoundedCollection(getMember(document, "fonts"), "fonts");
  const linkScan = scanBoundedCollection(getMember(document, "links"), "links");
  const textFrameScan = scanBoundedCollection(getMember(document, "textFrames"), "text frames");
  const missingFonts: string[] = [];
  const missingLinks: string[] = [];
  const modifiedLinks: string[] = [];
  const oversetText: InDesignObjectRef[] = [];
  const counts = { missingFonts: 0, missingLinks: 0, modifiedLinks: 0, oversetText: 0 };
  let returned = 0;
  let representationFailed = false;
  const canReturn = (): boolean => returned < maxResults;

  for (const font of fontScan.items) {
    if (!missingFontStatuses.has(getMember(font, "status"))) continue;
    counts.missingFonts += 1;
    const name = safeText(getMember(font, "name"));
    if (canReturn() && name.length > 0) { missingFonts.push(name); returned += 1; }
    else if (name.length === 0) representationFailed = true;
  }
  for (const link of linkScan.items) {
    const status = getMember(link, "status");
    const name = safeText(getMember(link, "name"));
    if (missingLinkStatuses.has(status)) {
      counts.missingLinks += 1;
      if (canReturn() && name.length > 0) { missingLinks.push(name); returned += 1; }
      else if (name.length === 0) representationFailed = true;
    } else if (status === modifiedLinkStatus) {
      counts.modifiedLinks += 1;
      if (canReturn() && name.length > 0) { modifiedLinks.push(name); returned += 1; }
      else if (name.length === 0) representationFailed = true;
    }
  }
  for (const frame of textFrameScan.items) {
    if (getMember(frame, "overflows") !== true) continue;
    counts.oversetText += 1;
    if (!canReturn()) continue;
    try {
      oversetText.push(identity.objectRef(document, frame));
      returned += 1;
    } catch {
      representationFailed = true;
    }
  }
  const totalFindings = counts.missingFonts + counts.missingLinks + counts.modifiedLinks + counts.oversetText;
  const scanComplete = fontScan.complete && linkScan.complete && textFrameScan.complete;
  return {
    missingFonts,
    missingLinks,
    modifiedLinks,
    oversetText,
    counts,
    totalFindings,
    scanComplete,
    truncated: !scanComplete || representationFailed || returned < totalFindings,
  };
}

function collectDocumentWarnings(document: unknown): string[] {
  const warnings: string[] = [];
  for (const frame of collectionItems(getMember(document, "textFrames"), 500)) {
    if (getMember(frame, "overflows") === true) warnings.push("Overset text detected.");
    if (warnings.length >= 500) break;
  }
  return warnings;
}

function createdAliasReferences(
  operations: readonly Operation[],
  aliases: Readonly<Record<string, InDesignObjectRef>>,
): InDesignObjectRef[] {
  const references: InDesignObjectRef[] = [];
  for (const operation of operations) {
    if (operation.ref === undefined || !operationAlwaysCreatesObject(operation)) continue;
    const reference = aliases[operation.ref];
    if (reference !== undefined) references.push(reference);
  }
  return references;
}

function operationAlwaysCreatesObject(operation: Operation): boolean {
  switch (operation.type) {
    case "create_page":
    case "create_rectangle":
    case "create_oval":
    case "create_text_frame":
    case "group_items":
      return true;
    case "ensure_layer":
    case "set_text":
    case "set_item_bounds":
    case "set_item_appearance":
    case "create_or_update_color":
    case "create_or_update_paragraph_style":
    case "apply_paragraph_style":
    case "create_or_update_object_style":
    case "apply_object_style":
    case "place_file":
    case "move_item_to_layer":
      return false;
  }
}

function truncation(truncatedValue: boolean, returnedItems: number, totalItems: number | undefined, reason: string): Record<string, unknown> {
  return {
    truncated: truncatedValue,
    reasons: truncatedValue ? [reason] : [],
    returnedItems,
    ...(totalItems === undefined ? {} : { totalItems }),
  };
}

function isValid(value: unknown): boolean {
  return value !== undefined && value !== null && getMember(value, "isValid") !== false;
}

function safeFailureToken(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 100
    && /^[a-z0-9.-]+$/u.test(value)
    ? value
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function assertPageReference(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value) || getMember(value, "kind") !== "page") {
    throw new SafeBridgeError("INVALID_INPUT", `${label} must be an explicit page reference.`);
  }
}

function requiredUniqueExportPageName(document: unknown, page: unknown): string {
  const value = getMember(page, "name");
  if (typeof value !== "string" && typeof value !== "number") {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign did not provide a page name required for bounded export.");
  }
  const name = String(value);
  if (
    name.length === 0
    || name.length > 255
    || containsControlCharacter(name)
    || !/^[\p{L}\p{N}_ ]+$/u.test(name)
  ) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign returned a page name that cannot be used safely for bounded export.");
  }
  const pages = collectionItems(getMember(document, "pages"), 10_001);
  if (pages.length > 10_000) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "The document has too many pages to verify an explicit export range safely.");
  }
  const requestedId = Number(getMember(page, "id"));
  const matches = pages.filter((candidate) => String(getMember(candidate, "name")) === name);
  if (
    !Number.isInteger(requestedId)
    || matches.length !== 1
    || Number(getMember(matches[0], "id")) !== requestedId
  ) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "The explicit page name is ambiguous and cannot be exported without risking additional pages.",
    );
  }
  return name;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}
