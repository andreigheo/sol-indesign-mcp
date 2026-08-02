import { randomUUID } from "node:crypto";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { parseWorkspaceRelativePath, WorkspacePathError } from "@sol/security";
import * as z from "zod/v4";
import {
  ApplyOperationsInputSchema,
  ApplyOperationsOutputSchema,
  ApplyOperationsResultSchema,
  BridgeErrorSchema,
  CreateDocumentInputSchema,
  CreateDocumentOutputSchema,
  CreateDocumentResultSchema,
  ExportDocumentInputSchema,
  ExportDocumentOutputSchema,
  ExportDocumentResultSchema,
  ExportedFileMetadataSchema,
  ExportPreviewBridgeResultSchema,
  ExportPreviewInputSchema,
  ExportPreviewOutputSchema,
  ExportPreviewResultSchema,
  InspectItemsInputSchema,
  InspectItemsOutputSchema,
  InspectItemsResultSchema,
  ListDocumentsInputSchema,
  ListDocumentsOutputSchema,
  ListDocumentsResultSchema,
  PluginStatusResultSchema,
  RunPreflightInputSchema,
  RunPreflightOutputSchema,
  PreflightResultSchema,
  SaveCopyInputSchema,
  SaveCopyOutputSchema,
  SaveCopyResultSchema,
  SelectionInputSchema,
  SelectionOutputSchema,
  SelectionResultSchema,
  SnapshotInputSchema,
  SnapshotOutputSchema,
  SnapshotResultSchema,
  SolBridgeError,
  StatusInputSchema,
  StatusOutputSchema,
  StatusResultSchema,
  type BridgeError,
  type BridgeMethod,
} from "@sol/protocol";
import type { BridgeServer } from "../bridge/server.js";
import { SERVER_VERSION } from "../config.js";
import type { JsonLogger } from "../logger.js";

export const SERVER_INSTRUCTIONS = "Before any write, call indesign_status and indesign_get_document_snapshot. Pass an explicit documentRef and expected revision. Never overwrite, close without saving, delete, or package a document without explicit user approval. Use workspace-relative paths only. Prefer one validated batch. After major visual changes, export and inspect a preview.";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

interface ToolSpec<InputSchema extends z.ZodType, ResultSchema extends z.ZodType, OutputSchema extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly resultSchema: ResultSchema;
  readonly outputSchema: OutputSchema;
  readonly method: BridgeMethod;
  readonly timeoutMs: number;
  readonly annotations: ToolAnnotations;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const ADDITIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function toError(error: unknown, traceId: string): BridgeError {
  if (error instanceof SolBridgeError) return error.toBridgeError();
  if (error instanceof z.ZodError) {
    return BridgeErrorSchema.parse({
      code: "VALIDATION_ERROR",
      message: "The bridge returned data that did not match the declared schema.",
      traceId,
      retryable: false,
      details: { issues: error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
  const offline = error instanceof Error && /bridge connection closed|not connected/i.test(error.message);
  return BridgeErrorSchema.parse({
    code: offline ? "BRIDGE_OFFLINE" : "INTERNAL_ERROR",
    message: offline ? "The InDesign UXP bridge disconnected while handling the request." : "The MCP server could not complete the request.",
    traceId,
    retryable: offline,
  });
}

function textForOutput(output: unknown): string {
  const text = JSON.stringify(output);
  return text.length <= 250_000 ? text : `${text.slice(0, 250_000)}…`;
}

interface PathRequirement {
  readonly rule: string;
  readonly prefix?: string;
  readonly extensions?: readonly string[];
}

function pathPolicyError(
  traceId: string,
  requirement: PathRequirement,
  cause?: WorkspacePathError,
): SolBridgeError {
  return new SolBridgeError({
    code: "PATH_NOT_ALLOWED",
    message: "The requested file path is not permitted inside the authorized workspace.",
    traceId,
    retryable: false,
    details: {
      rule: requirement.rule,
      ...(cause === undefined ? {} : {
        pathPolicyCode: cause.code,
        ...(cause.segmentIndex === undefined ? {} : { segmentIndex: cause.segmentIndex }),
      }),
    },
  });
}

function assertServerWorkspacePath(path: string, traceId: string, requirement: PathRequirement): void {
  try {
    parseWorkspaceRelativePath(path, { maxPathLength: 1_024 });
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) throw pathPolicyError(traceId, requirement, error);
    throw error;
  }
  if (requirement.prefix !== undefined && !path.startsWith(`${requirement.prefix}/`)) {
    throw pathPolicyError(traceId, requirement);
  }
  if (requirement.extensions !== undefined && !requirement.extensions.some((extension) => path.endsWith(extension))) {
    throw pathPolicyError(traceId, requirement);
  }
}

function assertServerPathPolicy(method: BridgeMethod, input: unknown, traceId: string): void {
  switch (method) {
    case "document.applyOperations": {
      const parsed = ApplyOperationsInputSchema.parse(input);
      for (const operation of parsed.operations) {
        if (operation.type === "place_file") {
          assertServerWorkspacePath(operation.path, traceId, { rule: "place_file_workspace_relative" });
        }
      }
      return;
    }
    case "document.exportPreview": {
      const parsed = ExportPreviewInputSchema.parse(input);
      assertServerWorkspacePath(parsed.targetPath, traceId, {
        rule: "preview_png_below_previews",
        prefix: "previews",
        extensions: [".png"],
      });
      return;
    }
    case "document.saveCopy": {
      const parsed = SaveCopyInputSchema.parse(input);
      assertServerWorkspacePath(parsed.targetPath, traceId, {
        rule: "save_copy_indd",
        extensions: [".indd"],
      });
      return;
    }
    case "document.export": {
      const parsed = ExportDocumentInputSchema.parse(input);
      const extensions: Readonly<Record<typeof parsed.format, readonly string[]>> = {
        pdf: [".pdf"],
        png: [".png"],
        jpeg: [".jpg", ".jpeg"],
        idml: [".idml"],
      };
      assertServerWorkspacePath(parsed.targetPath, traceId, {
        rule: `export_${parsed.format}`,
        extensions: extensions[parsed.format],
      });
      return;
    }
    default:
      return;
  }
}

function unsafeBridgeResult(traceId: string, rule: string): SolBridgeError {
  return new SolBridgeError({
    code: "DOM_ERROR",
    message: "The InDesign plugin returned an invalid or unsafe file result.",
    traceId,
    retryable: false,
    details: { rule },
  });
}

function assertExportedFile(
  value: unknown,
  traceId: string,
  requirement: PathRequirement & { readonly format: z.output<typeof ExportedFileMetadataSchema>["format"] },
): z.output<typeof ExportedFileMetadataSchema> {
  const file = ExportedFileMetadataSchema.parse(value);
  assertServerWorkspacePath(file.workspacePath, traceId, requirement);
  if (file.format !== requirement.format) throw unsafeBridgeResult(traceId, `${requirement.rule}_format`);
  return file;
}

function assertBridgeResultPolicy(method: BridgeMethod, input: unknown, result: unknown, traceId: string): void {
  switch (method) {
    case "document.exportPreview": {
      const request = ExportPreviewInputSchema.parse(input);
      const preview = ExportPreviewBridgeResultSchema.parse(result);
      const file = assertExportedFile(preview.file, traceId, {
        rule: "preview_png_below_previews",
        prefix: "previews",
        extensions: [".png"],
        format: "png",
      });
      if (file.workspacePath !== request.targetPath || file.widthPx === undefined || file.heightPx === undefined) {
        throw unsafeBridgeResult(traceId, "preview_metadata");
      }
      if (Math.max(file.widthPx, file.heightPx) > request.maxDimensionPx || Math.max(file.widthPx, file.heightPx) > 2_048) {
        throw unsafeBridgeResult(traceId, "preview_dimensions");
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(preview.imageBase64)) {
        throw unsafeBridgeResult(traceId, "preview_base64");
      }
      const bytes = Buffer.from(preview.imageBase64, "base64");
      if (bytes.byteLength > 4 * 1024 * 1024 || bytes.byteLength !== file.bytes) {
        throw unsafeBridgeResult(traceId, "preview_size");
      }
      if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw unsafeBridgeResult(traceId, "preview_png_signature");
      }
      const dimensions = readPngDimensions(bytes, traceId);
      if (
        dimensions.width !== file.widthPx
        || dimensions.height !== file.heightPx
        || Math.max(dimensions.width, dimensions.height) > request.maxDimensionPx
        || Math.max(dimensions.width, dimensions.height) > 2_048
      ) {
        throw unsafeBridgeResult(traceId, "preview_ihdr_dimensions");
      }
      return;
    }
    case "document.saveCopy": {
      const request = SaveCopyInputSchema.parse(input);
      const output = SaveCopyResultSchema.parse(result);
      const file = assertExportedFile(output.file, traceId, {
        rule: "save_copy_indd",
        extensions: [".indd"],
        format: "indd",
      });
      if (file.workspacePath !== request.targetPath) throw unsafeBridgeResult(traceId, "save_copy_target");
      return;
    }
    case "document.export": {
      const request = ExportDocumentInputSchema.parse(input);
      const output = ExportDocumentResultSchema.parse(result);
      const requirements = {
        pdf: { extensions: [".pdf"], format: "pdf" },
        png: { extensions: [".png"], format: "png" },
        jpeg: { extensions: [".jpg", ".jpeg"], format: "jpeg" },
        idml: { extensions: [".idml"], format: "idml" },
      } as const;
      for (const file of output.files) {
        assertExportedFile(file, traceId, {
          rule: `export_${request.format}`,
          ...requirements[request.format],
        });
      }
      if (output.files.length !== 1 || output.files[0]?.workspacePath !== request.targetPath) {
        throw unsafeBridgeResult(traceId, "export_target");
      }
      return;
    }
    default:
      return;
  }
}

function readPngDimensions(bytes: Buffer, traceId: string): { readonly width: number; readonly height: number } {
  if (
    bytes.byteLength < 24
    || bytes.readUInt32BE(8) !== 13
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw unsafeBridgeResult(traceId, "preview_png_ihdr");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw unsafeBridgeResult(traceId, "preview_png_ihdr");
  return { width, height };
}

async function executeBridgeTool<InputSchema extends z.ZodType, ResultSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  spec: ToolSpec<InputSchema, ResultSchema, OutputSchema>,
  input: z.output<InputSchema>,
  extra: Extra,
  bridge: BridgeServer,
  logger: JsonLogger,
): Promise<CallToolResult> {
  const traceId = randomUUID();
  const started = performance.now();
  try {
    const parsedInput = spec.inputSchema.parse(input);
    assertServerPathPolicy(spec.method, parsedInput, traceId);
    const raw = await bridge.request(spec.method, parsedInput as Readonly<Record<string, unknown>>, traceId, spec.timeoutMs, extra.signal);
    const result = spec.resultSchema.parse(raw);
    assertBridgeResultPolicy(spec.method, parsedInput, result, traceId);
    const output = spec.outputSchema.parse({ traceId, outcome: { ok: true, result } });
    logger.log("info", "tool_completed", {
      traceId,
      tool: spec.name,
      bridgeMethod: spec.method,
      durationMs: Math.round(performance.now() - started),
      resultCode: "OK",
    });
    return { content: [{ type: "text", text: textForOutput(output) }], structuredContent: output as Record<string, unknown> };
  } catch (error: unknown) {
    const bridgeError = toError(error, traceId);
    const output = spec.outputSchema.parse({ traceId, outcome: { ok: false, error: bridgeError } });
    logger.log("warn", "tool_failed", {
      traceId,
      tool: spec.name,
      bridgeMethod: spec.method,
      durationMs: Math.round(performance.now() - started),
      resultCode: bridgeError.code,
    });
    return { content: [{ type: "text", text: textForOutput(output) }], structuredContent: output as Record<string, unknown>, isError: true };
  }
}

function registerBridgeTool<InputSchema extends z.ZodType, ResultSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  server: McpServer,
  spec: ToolSpec<InputSchema, ResultSchema, OutputSchema>,
  bridge: BridgeServer,
  logger: JsonLogger,
): void {
  // The SDK's callback type is a conditional over the concrete schema type. It
  // cannot reduce that conditional while this helper remains generic, even
  // though every call below supplies a concrete Zod v4 object schema.
  const callback = (async (
    input: z.output<InputSchema>,
    extra: Extra,
  ): Promise<CallToolResult> => await executeBridgeTool(spec, input, extra, bridge, logger)) as ToolCallback<InputSchema>;
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      annotations: spec.annotations,
    },
    callback,
  );
}

export function registerTools(server: McpServer, bridge: BridgeServer, logger: JsonLogger): void {
  server.registerTool(
    "indesign_status",
    {
      title: "InDesign bridge status",
      description: "Returns bounded MCP server, UXP bridge, authentication, InDesign, workspace, queue, active-document, and runtime-capability status. Call this before every write. This tool never changes InDesign.",
      inputSchema: StatusInputSchema,
      outputSchema: StatusOutputSchema,
      annotations: READ_ONLY,
    },
    async (_input, extra): Promise<CallToolResult> => {
      const traceId = randomUUID();
      const started = performance.now();
      try {
        const bridgeStatus = bridge.status();
        const remote = bridgeStatus.authenticated
          ? PluginStatusResultSchema.parse(
              await bridge.request("indesign.status", {}, traceId, 5_000, extra.signal),
            )
          : null;
        const status = bridge.status();
        const cachedResult = PluginStatusResultSchema.safeParse(status.pluginStatus);
        const cached = cachedResult.success ? cachedResult.data : null;
        const plugin = remote ?? cached;
        const result = StatusResultSchema.parse({
          serverVersion: SERVER_VERSION,
          bridgeProtocolVersion: "sol-indesign-bridge/1",
          bridgeConnected: status.bridgeConnected,
          authenticated: status.authenticated,
          transport: status.transport,
          pluginVersion: plugin?.pluginVersion ?? status.pluginVersion,
          inDesignVersion: plugin?.inDesignVersion ?? status.inDesignVersion,
          activeDocument: plugin?.activeDocument ?? null,
          workspaceAuthorized: plugin?.workspaceAuthorized ?? false,
          queueDepth: plugin?.queueDepth ?? 0,
          capabilities: plugin?.capabilities ?? {},
          lastHeartbeat: status.lastHeartbeat,
          lastErrorCode: status.lastErrorCode,
        });
        const output = StatusOutputSchema.parse({ traceId, outcome: { ok: true, result } });
        logger.log("info", "tool_completed", {
          traceId,
          tool: "indesign_status",
          bridgeMethod: "indesign.status",
          durationMs: Math.round(performance.now() - started),
          resultCode: "OK",
        });
        return { content: [{ type: "text", text: textForOutput(output) }], structuredContent: output };
      } catch (error: unknown) {
        const bridgeError = toError(error, traceId);
        const output = StatusOutputSchema.parse({ traceId, outcome: { ok: false, error: bridgeError } });
        logger.log("warn", "tool_failed", {
          traceId,
          tool: "indesign_status",
          bridgeMethod: "indesign.status",
          durationMs: Math.round(performance.now() - started),
          resultCode: bridgeError.code,
        });
        return { content: [{ type: "text", text: textForOutput(output) }], structuredContent: output, isError: true };
      }
    },
  );

  registerBridgeTool(server, {
    name: "indesign_list_documents",
    title: "List open InDesign documents",
    description: "Lists bounded summaries and explicit references for open InDesign documents without changing labels or document content.",
    inputSchema: ListDocumentsInputSchema,
    resultSchema: ListDocumentsResultSchema,
    outputSchema: ListDocumentsOutputSchema,
    method: "document.list",
    timeoutMs: 5_000,
    annotations: READ_ONLY,
  }, bridge, logger);
  registerBridgeTool(server, {
    name: "indesign_get_document_snapshot",
    title: "Get bounded document snapshot",
    description: "Returns a bounded, revisioned structural snapshot for the explicit document. Text is omitted unless short snippets are requested. Call before every document write.",
    inputSchema: SnapshotInputSchema,
    resultSchema: SnapshotResultSchema,
    outputSchema: SnapshotOutputSchema,
    method: "document.snapshot",
    timeoutMs: 30_000,
    annotations: READ_ONLY,
  }, bridge, logger);
  registerBridgeTool(server, {
    name: "indesign_get_selection",
    title: "Get current InDesign selection",
    description: "Returns bounded references for the current user selection in the explicit document. Selection is never used implicitly by write tools.",
    inputSchema: SelectionInputSchema,
    resultSchema: SelectionResultSchema,
    outputSchema: SelectionOutputSchema,
    method: "document.selection",
    timeoutMs: 30_000,
    annotations: READ_ONLY,
  }, bridge, logger);
  registerBridgeTool(server, {
    name: "indesign_inspect_items",
    title: "Inspect explicit InDesign items",
    description: "Inspects up to 100 explicit object references, verifies document ownership, and returns bounded geometry, style, link, and optional short-text details.",
    inputSchema: InspectItemsInputSchema,
    resultSchema: InspectItemsResultSchema,
    outputSchema: InspectItemsOutputSchema,
    method: "document.inspectItems",
    timeoutMs: 30_000,
    annotations: READ_ONLY,
  }, bridge, logger);
  registerBridgeTool(server, {
    name: "indesign_create_document",
    title: "Create an InDesign document",
    description: "Creates a new unsaved A4 or custom document with bounded page, facing-page, margin, and bleed settings. It does not save or overwrite a file.",
    inputSchema: CreateDocumentInputSchema,
    resultSchema: CreateDocumentResultSchema,
    outputSchema: CreateDocumentOutputSchema,
    method: "document.create",
    timeoutMs: 60_000,
    annotations: ADDITIVE_WRITE,
  }, bridge, logger);
  registerBridgeTool(server, {
    name: "indesign_apply_operations",
    title: "Apply validated InDesign operations",
    description: "Validates and optionally applies one typed operation batch to an explicit document revision. Supports local refs, dry-run, fingerprints, one Undo step, and no delete operation.",
    inputSchema: ApplyOperationsInputSchema,
    resultSchema: ApplyOperationsResultSchema,
    outputSchema: ApplyOperationsOutputSchema,
    method: "document.applyOperations",
    timeoutMs: 60_000,
    annotations: DESTRUCTIVE_WRITE,
  }, bridge, logger);
  server.registerTool(
    "indesign_export_preview",
    {
      title: "Export an InDesign PNG preview",
      description: "Exports one explicit page to a bounded PNG under the authorized previews directory, returns the workspace-relative path and MCP image content, and never overwrites unless explicitly requested.",
      inputSchema: ExportPreviewInputSchema,
      outputSchema: ExportPreviewOutputSchema,
      annotations: DESTRUCTIVE_WRITE,
    },
    async (input, extra): Promise<CallToolResult> => {
      const traceId = randomUUID();
      const started = performance.now();
      try {
        const parsed = ExportPreviewInputSchema.parse(input);
        assertServerPathPolicy("document.exportPreview", parsed, traceId);
        const raw = await bridge.request("document.exportPreview", parsed, traceId, 110_000, extra.signal);
        const bridgeResult = ExportPreviewBridgeResultSchema.parse(raw);
        assertBridgeResultPolicy("document.exportPreview", parsed, bridgeResult, traceId);
        const result = ExportPreviewResultSchema.parse({ file: bridgeResult.file });
        const output = ExportPreviewOutputSchema.parse({ traceId, outcome: { ok: true, result } });
        logger.log("info", "tool_completed", {
          traceId,
          tool: "indesign_export_preview",
          bridgeMethod: "document.exportPreview",
          durationMs: Math.round(performance.now() - started),
          resultCode: "OK",
        });
        return {
          content: [
            { type: "text", text: textForOutput(output) },
            { type: "image", data: bridgeResult.imageBase64, mimeType: "image/png" },
          ],
          structuredContent: output,
        };
      } catch (error: unknown) {
        const bridgeError = toError(error, traceId);
        const output = ExportPreviewOutputSchema.parse({ traceId, outcome: { ok: false, error: bridgeError } });
        logger.log("warn", "tool_failed", {
          traceId,
          tool: "indesign_export_preview",
          bridgeMethod: "document.exportPreview",
          durationMs: Math.round(performance.now() - started),
          resultCode: bridgeError.code,
        });
        return { content: [{ type: "text", text: textForOutput(output) }], structuredContent: output, isError: true };
      }
    },
  );
  registerBridgeTool(server, {
    name: "indesign_save_copy",
    title: "Save an InDesign copy",
    description: "Saves a copy of the explicit document inside the authorized workspace while leaving the source document open. Existing files are protected by default.",
    inputSchema: SaveCopyInputSchema,
    resultSchema: SaveCopyResultSchema,
    outputSchema: SaveCopyOutputSchema,
    method: "document.saveCopy",
    timeoutMs: 110_000,
    annotations: DESTRUCTIVE_WRITE,
  }, bridge, logger);
  registerBridgeTool(server, {
    name: "indesign_export_document",
    title: "Export an InDesign document",
    description: "Exports the explicit document as PDF, PNG, JPEG, or IDML inside the authorized workspace. PDF requires an existing named preset; overwrite is always opt-in.",
    inputSchema: ExportDocumentInputSchema,
    resultSchema: ExportDocumentResultSchema,
    outputSchema: ExportDocumentOutputSchema,
    method: "document.export",
    timeoutMs: 110_000,
    annotations: DESTRUCTIVE_WRITE,
  }, bridge, logger);
  registerBridgeTool(server, {
    name: "indesign_run_preflight",
    title: "Run InDesign preflight",
    description: "Runs the selected InDesign preflight profile against the explicit document, returns bounded reported errors plus separate supported checks, and does not fabricate warning severity.",
    inputSchema: RunPreflightInputSchema,
    resultSchema: PreflightResultSchema,
    outputSchema: RunPreflightOutputSchema,
    method: "document.preflight",
    timeoutMs: 110_000,
    annotations: READ_ONLY,
  }, bridge, logger);
}
