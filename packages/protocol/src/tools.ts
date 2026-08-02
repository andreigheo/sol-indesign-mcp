import * as z from "zod/v4";
import {
  BoundsSchema,
  BoundedDetailsSchema,
  CapabilitySchema,
  DocumentRefSchema,
  InDesignObjectRefSchema,
  PageReferenceSchema,
  TruncationSchema,
  UnitSchema,
} from "./common.js";
import { BridgeErrorSchema } from "./errors.js";
import { OperationSchema } from "./operations.js";

export function createToolOutputSchema<ResultSchema extends z.ZodType>(resultSchema: ResultSchema) {
  return z.strictObject({
    traceId: z.uuid(),
    outcome: z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), result: resultSchema }),
      z.strictObject({ ok: z.literal(false), error: BridgeErrorSchema }),
    ]),
  });
}

export const ToolNameSchema = z.enum([
  "indesign_status",
  "indesign_list_documents",
  "indesign_get_document_snapshot",
  "indesign_get_selection",
  "indesign_inspect_items",
  "indesign_create_document",
  "indesign_apply_operations",
  "indesign_export_preview",
  "indesign_save_copy",
  "indesign_export_document",
  "indesign_run_preflight",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

const CapabilitiesSchema = z.record(z.string().max(100), CapabilitySchema).superRefine((value, context) => {
  if (Object.keys(value).length > 100) context.addIssue({ code: "custom", message: "Capabilities exceed 100 entries." });
});

const CountsSchema = z.record(z.string().max(100), z.number().int().nonnegative()).superRefine((value, context) => {
  if (Object.keys(value).length > 100) context.addIssue({ code: "custom", message: "Counts exceed 100 entries." });
});

function requireExpectedRevision(
  documentRef: z.output<typeof DocumentRefSchema>,
  expectedRevision: number,
  context: z.RefinementCtx,
): void {
  if (documentRef.revision !== expectedRevision) {
    context.addIssue({
      code: "custom",
      path: ["expectedRevision"],
      message: "expectedRevision must equal documentRef.revision.",
    });
  }
}

function requireDocumentOwner(
  documentUuid: string,
  ownerUuid: string,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (ownerUuid !== documentUuid) {
    context.addIssue({
      code: "custom",
      path,
      message: "The reference must belong to the requested document.",
    });
  }
}

function requireNestedReferenceOwners(
  value: unknown,
  documentUuid: string,
  context: z.RefinementCtx,
  path: PropertyKey[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => requireNestedReferenceOwners(entry, documentUuid, context, [...path, index]));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.documentUuid === "string") {
    requireDocumentOwner(documentUuid, record.documentUuid, context, [...path, "documentUuid"]);
  }
  for (const [key, entry] of Object.entries(record)) {
    if (key !== "documentUuid") requireNestedReferenceOwners(entry, documentUuid, context, [...path, key]);
  }
}

function requireResultRevision(
  documentRef: z.output<typeof DocumentRefSchema>,
  revision: number,
  context: z.RefinementCtx,
): void {
  if (documentRef.revision !== revision) {
    context.addIssue({
      code: "custom",
      path: ["revision"],
      message: "revision must equal documentRef.revision.",
    });
  }
}

export const ActiveDocumentSummarySchema = z.strictObject({
  documentRef: DocumentRefSchema,
  modified: z.boolean(),
  pageCount: z.number().int().nonnegative(),
});

export const PluginStatusResultSchema = z.strictObject({
  pluginVersion: z.string().min(1).max(100),
  inDesignVersion: z.string().min(1).max(100),
  activeDocument: ActiveDocumentSummarySchema.nullable(),
  workspaceAuthorized: z.boolean(),
  queueDepth: z.number().int().nonnegative().max(256),
  capabilities: CapabilitiesSchema,
});
export type PluginStatusResult = z.infer<typeof PluginStatusResultSchema>;

export const StatusInputSchema = z.strictObject({});
export const StatusResultSchema = z.strictObject({
  serverVersion: z.string(),
  bridgeProtocolVersion: z.string(),
  bridgeConnected: z.boolean(),
  authenticated: z.boolean(),
  transport: z.enum(["websocket", "http"]).nullable(),
  pluginVersion: z.string().nullable(),
  inDesignVersion: z.string().nullable(),
  activeDocument: ActiveDocumentSummarySchema.nullable(),
  workspaceAuthorized: z.boolean(),
  queueDepth: z.number().int().nonnegative().max(256),
  capabilities: CapabilitiesSchema,
  lastHeartbeat: z.iso.datetime().nullable(),
  lastErrorCode: z.string().nullable(),
});
export const StatusOutputSchema = createToolOutputSchema(StatusResultSchema);

export const ListDocumentsInputSchema = z.strictObject({
  maxDocuments: z.number().int().min(1).max(200).default(50),
});
export const DocumentSummarySchema = z.strictObject({
  documentRef: DocumentRefSchema,
  active: z.boolean(),
  modified: z.boolean(),
  saved: z.boolean(),
  pageCount: z.number().int().nonnegative(),
});
export const ListDocumentsResultSchema = z.strictObject({
  documents: z.array(DocumentSummarySchema).max(200),
  truncation: TruncationSchema,
});
export const ListDocumentsOutputSchema = createToolOutputSchema(ListDocumentsResultSchema);

export const SnapshotInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  maxDepth: z.number().int().min(0).max(8).default(3),
  maxItems: z.number().int().min(1).max(2_000).default(500),
  includeTextSnippets: z.boolean().default(false),
  includeStyles: z.boolean().default(false),
  includeLinks: z.boolean().default(false),
  includeWarnings: z.boolean().default(false),
  expectedUndoTraceId: z.uuid().optional(),
});
export const UndoVerificationSchema = z.strictObject({
  targetDocumentActive: z.boolean(),
  applicationUndoMatches: z.boolean(),
  documentUndoMatches: z.boolean(),
  applicationRedoMatches: z.boolean(),
  documentRedoMatches: z.boolean(),
  createdAliasesMissing: z.boolean().nullable(),
  proofComplete: z.boolean(),
});

export const SnapshotItemSchema = z.strictObject({
  objectRef: InDesignObjectRefSchema,
  bounds: BoundsSchema.optional(),
  textSnippet: z.string().max(500).optional(),
  childCount: z.number().int().nonnegative().optional(),
  styleNames: z.array(z.string().max(255)).max(20).optional(),
  linkStatus: z.string().max(100).optional(),
  warnings: z.array(z.string().max(500)).max(20).optional(),
});
export const SnapshotResultSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  revision: z.number().int().positive(),
  pages: z.array(InDesignObjectRefSchema).max(2_000),
  layers: z.array(InDesignObjectRefSchema).max(2_000),
  items: z.array(SnapshotItemSchema).max(2_000),
  counts: CountsSchema,
  styles: z.array(z.string().max(255)).max(2_000).optional(),
  links: z.array(z.string().max(512)).max(2_000).optional(),
  warnings: z.array(z.string().max(500)).max(500).optional(),
  undoVerification: UndoVerificationSchema.optional(),
  truncation: TruncationSchema,
}).superRefine((value, context) => {
  requireResultRevision(value.documentRef, value.revision, context);
  requireNestedReferenceOwners(
    { pages: value.pages, layers: value.layers, items: value.items },
    value.documentRef.documentUuid,
    context,
  );
});
export const SnapshotOutputSchema = createToolOutputSchema(SnapshotResultSchema);

export const SelectionInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  maxItems: z.number().int().min(1).max(100).default(100),
  includeTextSnippets: z.boolean().default(false),
});
export const SelectionResultSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  items: z.array(SnapshotItemSchema).max(100),
  truncation: TruncationSchema,
}).superRefine((value, context) => {
  requireNestedReferenceOwners(value.items, value.documentRef.documentUuid, context, ["items"]);
});
export const SelectionOutputSchema = createToolOutputSchema(SelectionResultSchema);

export const InspectItemsInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  objectRefs: z.array(InDesignObjectRefSchema).min(1).max(100),
  includeTextSnippets: z.boolean().default(false),
  includeStyles: z.boolean().default(false),
  includeLinks: z.boolean().default(false),
}).superRefine((value, context) => {
  requireNestedReferenceOwners(value.objectRefs, value.documentRef.documentUuid, context, ["objectRefs"]);
});
export const InspectItemsResultSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  items: z.array(SnapshotItemSchema).max(100),
  missing: z.array(InDesignObjectRefSchema).max(100),
}).superRefine((value, context) => {
  requireNestedReferenceOwners(
    { items: value.items, missing: value.missing },
    value.documentRef.documentUuid,
    context,
  );
});
export const InspectItemsOutputSchema = createToolOutputSchema(InspectItemsResultSchema);

const FourSidedMeasurementSchema = z.strictObject({
  top: z.number().min(0),
  right: z.number().min(0),
  bottom: z.number().min(0),
  left: z.number().min(0),
  unit: UnitSchema,
});
export const CreateDocumentInputSchema = z.strictObject({
  pageSize: z.union([
    z.strictObject({ preset: z.literal("A4") }),
    z.strictObject({
      width: z.number().positive(),
      height: z.number().positive(),
      unit: UnitSchema,
    }),
  ]).default({ preset: "A4" }),
  orientation: z.enum(["portrait", "landscape"]).default("portrait"),
  pageCount: z.number().int().min(1).max(100).default(1),
  facingPages: z.boolean().default(false),
  margins: FourSidedMeasurementSchema.optional(),
  bleed: FourSidedMeasurementSchema.optional(),
});
export const CreateDocumentResultSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  revision: z.number().int().positive(),
  pages: z.array(InDesignObjectRefSchema).min(1).max(100),
}).superRefine((value, context) => {
  requireResultRevision(value.documentRef, value.revision, context);
  requireNestedReferenceOwners(value.pages, value.documentRef.documentUuid, context, ["pages"]);
  value.pages.forEach((page, index) => {
    if (page.kind !== "page") {
      context.addIssue({ code: "custom", path: ["pages", index, "kind"], message: "Created page references must have kind page." });
    }
  });
});
export const CreateDocumentOutputSchema = createToolOutputSchema(CreateDocumentResultSchema);

export const ApplyOperationsInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  expectedRevision: z.number().int().positive(),
  operations: z.array(OperationSchema).min(1).max(100),
  dryRun: z.boolean().optional().transform((value) => value ?? false),
}).superRefine((value, context) => {
  requireExpectedRevision(value.documentRef, value.expectedRevision, context);
  requireNestedReferenceOwners(value.operations, value.documentRef.documentUuid, context, ["operations"]);
});
export const ApplyOperationsResultSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  revision: z.number().int().positive(),
  dryRun: z.boolean(),
  validatedOperationCount: z.number().int().nonnegative(),
  completedOperationCount: z.number().int().nonnegative(),
  aliases: z.record(z.string(), InDesignObjectRefSchema),
  warnings: z.array(z.string().max(500)).max(500),
  partialChanges: z.boolean(),
  undoRecommended: z.boolean(),
  undoLabel: z.string().max(255).nullable(),
}).superRefine((value, context) => {
  requireResultRevision(value.documentRef, value.revision, context);
  requireNestedReferenceOwners(value.aliases, value.documentRef.documentUuid, context, ["aliases"]);
  if (value.completedOperationCount > value.validatedOperationCount) {
    context.addIssue({
      code: "custom",
      path: ["completedOperationCount"],
      message: "completedOperationCount cannot exceed validatedOperationCount.",
    });
  }
});
export const ApplyOperationsOutputSchema = createToolOutputSchema(ApplyOperationsResultSchema);

export const ExportPreviewInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  expectedRevision: z.number().int().positive(),
  pageRef: InDesignObjectRefSchema,
  targetPath: z.string().min(1).max(1_024),
  maxDimensionPx: z.number().int().min(256).max(2_048).default(1_600),
  overwrite: z.boolean().default(false),
}).superRefine((value, context) => {
  requireExpectedRevision(value.documentRef, value.expectedRevision, context);
  requireDocumentOwner(value.documentRef.documentUuid, value.pageRef.documentUuid, context, ["pageRef", "documentUuid"]);
  if (value.pageRef.kind !== "page") {
    context.addIssue({ code: "custom", path: ["pageRef", "kind"], message: "pageRef must have kind page." });
  }
});
export const ExportedFileMetadataSchema = z.strictObject({
  workspacePath: z.string().min(1).max(1_024),
  format: z.enum(["png", "jpeg", "pdf", "idml", "indd"]),
  bytes: z.number().int().positive(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  mimeType: z.string().min(1).max(100),
});
export const ExportPreviewBridgeResultSchema = z.strictObject({
  file: ExportedFileMetadataSchema,
  imageBase64: z.string().max(5_592_408),
});
export const ExportPreviewResultSchema = z.strictObject({ file: ExportedFileMetadataSchema });
export const ExportPreviewOutputSchema = createToolOutputSchema(ExportPreviewResultSchema);

export const SaveCopyInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  expectedRevision: z.number().int().positive(),
  targetPath: z.string().min(1).max(1_024),
  overwrite: z.boolean().default(false),
}).superRefine((value, context) => {
  requireExpectedRevision(value.documentRef, value.expectedRevision, context);
});
export const SaveCopyResultSchema = z.strictObject({ file: ExportedFileMetadataSchema });
export const SaveCopyOutputSchema = createToolOutputSchema(SaveCopyResultSchema);

const ExportBaseShape = {
  documentRef: DocumentRefSchema,
  expectedRevision: z.number().int().positive(),
  targetPath: z.string().min(1).max(1_024),
  overwrite: z.boolean().default(false),
};
export const ExportDocumentInputSchema = z.discriminatedUnion("format", [
  z.strictObject({
    ...ExportBaseShape,
    format: z.literal("pdf"),
    pdfPresetName: z.string().min(1).max(255),
    pageRefs: z.array(InDesignObjectRefSchema).min(1).max(1_000).optional(),
  }),
  z.strictObject({
    ...ExportBaseShape,
    format: z.literal("png"),
    pageRefs: z.array(InDesignObjectRefSchema).min(1).max(1_000).optional(),
  }),
  z.strictObject({
    ...ExportBaseShape,
    format: z.literal("jpeg"),
    pageRefs: z.array(InDesignObjectRefSchema).min(1).max(1_000).optional(),
  }),
  z.strictObject({ ...ExportBaseShape, format: z.literal("idml") }),
]).superRefine((value, context) => {
  requireExpectedRevision(value.documentRef, value.expectedRevision, context);
  if ("pageRefs" in value && value.pageRefs !== undefined) {
    requireNestedReferenceOwners(value.pageRefs, value.documentRef.documentUuid, context, ["pageRefs"]);
    value.pageRefs.forEach((page, index) => {
      if (page.kind !== "page") {
        context.addIssue({ code: "custom", path: ["pageRefs", index, "kind"], message: "Page references must have kind page." });
      }
    });
  }
});
export const ExportDocumentResultSchema = z.strictObject({
  files: z.array(ExportedFileMetadataSchema).min(1).max(1_000),
});
export const ExportDocumentOutputSchema = createToolOutputSchema(ExportDocumentResultSchema);

export const RunPreflightInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  profileName: z.string().min(1).max(255).optional(),
  maxFindings: z.number().int().min(1).max(500).default(500),
});
export const PreflightFindingSchema = z.strictObject({
  category: z.string().min(1).max(255),
  message: z.string().min(1).max(1_000),
  page: PageReferenceSchema.optional(),
  objectRef: InDesignObjectRefSchema.optional(),
  details: z.array(z.string().max(250)).max(10).optional(),
});
const PreflightErrorsByCategorySchema = z.record(
  z.string().min(1).max(255),
  z.array(PreflightFindingSchema).max(500),
).superRefine((value, context) => {
  const categories = Object.values(value);
  if (categories.length > 100) context.addIssue({ code: "custom", message: "Preflight categories exceed 100 entries." });
  const findingCount = categories.reduce((total, findings) => total + findings.length, 0);
  if (findingCount > 500) context.addIssue({ code: "custom", message: "Preflight findings exceed 500 entries." });
});

export const PreflightResultSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  profileName: z.string().min(1).max(255),
  passed: z.boolean(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative().nullable(),
  warningCountAvailable: z.boolean(),
  errorsByCategory: PreflightErrorsByCategorySchema,
  missingFonts: z.array(z.string().max(255)).max(500),
  missingLinks: z.array(z.string().max(512)).max(500),
  modifiedLinks: z.array(z.string().max(512)).max(500),
  oversetText: z.array(InDesignObjectRefSchema).max(500),
  colorFindings: z.array(PreflightFindingSchema).max(500),
  additionalChecks: BoundedDetailsSchema,
  truncation: TruncationSchema,
}).superRefine((value, context) => {
  requireNestedReferenceOwners(
    {
      errorsByCategory: value.errorsByCategory,
      oversetText: value.oversetText,
      colorFindings: value.colorFindings,
    },
    value.documentRef.documentUuid,
    context,
  );
});
export const RunPreflightOutputSchema = createToolOutputSchema(PreflightResultSchema);

export type StatusResult = z.infer<typeof StatusResultSchema>;
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;
export type ApplyOperationsResult = z.infer<typeof ApplyOperationsResultSchema>;
export type ExportPreviewBridgeResult = z.infer<typeof ExportPreviewBridgeResultSchema>;
