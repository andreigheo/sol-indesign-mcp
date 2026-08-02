import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ApplyOperationsOutputSchema,
  CreateDocumentOutputSchema,
  ExportPreviewBridgeResultSchema,
  ExportPreviewOutputSchema,
  ListDocumentsResultSchema,
  SolBridgeError,
  StatusOutputSchema,
  type BridgeRequest,
} from "@sol/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthenticatedMockHttpUxpClient,
  AuthenticatedMockUxpClient,
  FakeInDesignAdapter,
  fixtureDocumentRef,
  fixturePageRef,
} from "../../../../packages/testkit/src/index.js";
import { BridgeServer } from "../bridge/server.js";
import { JsonLogger } from "../logger.js";
import { createMcpServer } from "../server-factory.js";

interface Closable {
  close(): Promise<void>;
}

interface BridgeHarness<ClientType extends Closable> {
  readonly bridge: BridgeServer;
  readonly client: ClientType;
  readonly adapter: FakeInDesignAdapter;
  readonly logger: JsonLogger;
  readonly logDirectory: string;
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function startWebSocketHarness(
  adapter = new FakeInDesignAdapter(),
  token = randomBytes(32),
  clientToken = token,
  authenticationAttempts = 1,
): Promise<BridgeHarness<AuthenticatedMockUxpClient>> {
  const logDirectory = await mkdtemp(join(tmpdir(), "sol-indesign-contract-"));
  const logger = new JsonLogger(logDirectory);
  const bridge = new BridgeServer({ host: "127.0.0.1", port: 0, token, logger });
  const port = await bridge.start();
  const client = new AuthenticatedMockUxpClient({
    baseUrl: `ws://127.0.0.1:${port}`,
    token: clientToken,
    dispatcher: adapter,
    authenticationAttempts,
  });
  cleanup.push(async () => {
    await client.close();
    await bridge.close();
    await logger.flush();
    await rm(logDirectory, { recursive: true, force: true });
  });
  await client.connect();
  return { bridge, client, adapter, logger, logDirectory };
}

async function startHttpHarness(adapter = new FakeInDesignAdapter({ transport: "http" })):
Promise<BridgeHarness<AuthenticatedMockHttpUxpClient>> {
  const token = randomBytes(32);
  const logDirectory = await mkdtemp(join(tmpdir(), "sol-indesign-http-contract-"));
  const logger = new JsonLogger(logDirectory);
  const bridge = new BridgeServer({ host: "127.0.0.1", port: 0, token, logger });
  const port = await bridge.start();
  const client = new AuthenticatedMockHttpUxpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    dispatcher: adapter,
  });
  cleanup.push(async () => {
    await client.close();
    await bridge.close();
    await logger.flush();
    await rm(logDirectory, { recursive: true, force: true });
  });
  await client.connect();
  return { bridge, client, adapter, logger, logDirectory };
}

async function connectMcp(bridge: BridgeServer, logger: JsonLogger) {
  const mcpServer = createMcpServer(bridge, logger);
  const mcpClient = new Client({ name: "sol-contract-client", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  cleanup.push(async () => {
    await mcpClient.close();
    await mcpServer.close();
  });
  return mcpClient;
}

class InvalidPluginResultAdapter extends FakeInDesignAdapter {
  override async dispatch(request: BridgeRequest): Promise<unknown> {
    if (request.method === "indesign.status") {
      return { pluginVersion: 42, workspaceAuthorized: "yes" };
    }
    if (request.method === "document.exportPreview") {
      return {
        file: {
          workspacePath: "previews/not-the-requested-file.png",
          format: "png",
          bytes: 3,
          widthPx: 1,
          heightPx: 1,
          mimeType: "image/png",
        },
        imageBase64: "AAAA",
      };
    }
    return await super.dispatch(request);
  }
}

class ForgedPreviewDimensionsAdapter extends FakeInDesignAdapter {
  override async dispatch(request: BridgeRequest): Promise<unknown> {
    const result = await super.dispatch(request);
    if (request.method !== "document.exportPreview") return result;
    const preview = ExportPreviewBridgeResultSchema.parse(result);
    return {
      ...preview,
      file: { ...preview.file, widthPx: 2, heightPx: 2 },
    };
  }
}

class PartialFailureAdapter extends FakeInDesignAdapter {
  override async dispatch(request: BridgeRequest): Promise<unknown> {
    if (request.method === "document.applyOperations") {
      throw new SolBridgeError({
        code: "PARTIAL_FAILURE",
        message: "The fake host stopped after a document mutation.",
        traceId: request.meta.traceId,
        retryable: false,
        details: {
          documentRef: fixtureDocumentRef(2),
          revision: 2,
          validatedOperationCount: 2,
          completedOperationCount: 1,
          aliases: {},
          partialChanges: true,
          undoRecommended: true,
          undoLabel: `Sol InDesign MCP · ${request.meta.traceId}`,
        },
      });
    }
    return await super.dispatch(request);
  }
}

describe("authenticated MCP to UXP bridge contract", () => {
  it("authenticates a WebSocket plugin and advertises exactly the eleven production tools", async () => {
    const harness = await startWebSocketHarness();
    const mcpClient = await connectMcp(harness.bridge, harness.logger);

    expect(harness.bridge.status()).toMatchObject({
      bridgeConnected: true,
      authenticated: true,
      transport: "websocket",
      pluginVersion: "0.1.0-test",
      inDesignVersion: "21.4.1-test",
    });
    const tools = await mcpClient.listTools();
    expect(tools.tools).toHaveLength(11);
    expect(tools.tools.map((tool) => tool.name)).not.toContain("indesign_delete_items");
    const applyOperations = tools.tools.find((tool) => tool.name === "indesign_apply_operations");
    expect(applyOperations?.title).toBeTypeOf("string");
    expect(applyOperations?.description).toBeTypeOf("string");
    expect(JSON.stringify(applyOperations?.inputSchema)).not.toContain('"default":');
  });

  it("runs MCP create_document through SDK transport, authenticated bridge, and fake adapter", async () => {
    const harness = await startWebSocketHarness();
    const mcpClient = await connectMcp(harness.bridge, harness.logger);

    const call = await mcpClient.callTool({
      name: "indesign_create_document",
      arguments: {
        pageSize: { preset: "A4" },
        orientation: "portrait",
        pageCount: 2,
        facingPages: false,
      },
    });

    expect(call.isError).not.toBe(true);
    const output = CreateDocumentOutputSchema.parse(call.structuredContent);
    expect(output.outcome.ok).toBe(true);
    if (output.outcome.ok) expect(output.outcome.result.pages).toHaveLength(2);
    expect(harness.adapter.requests.at(-1)?.method).toBe("document.create");
  });

  it("returns preview bytes as MCP image content while keeping bytes out of structured output", async () => {
    const harness = await startWebSocketHarness();
    const mcpClient = await connectMcp(harness.bridge, harness.logger);

    const call = await mcpClient.callTool({
      name: "indesign_export_preview",
      arguments: {
        documentRef: fixtureDocumentRef(),
        expectedRevision: 1,
        pageRef: fixturePageRef(),
        targetPath: "previews/contract.png",
        maxDimensionPx: 1_600,
        overwrite: false,
      },
    });

    const parsedCall = CallToolResultSchema.parse(call);
    const image = parsedCall.content.find((item) => item.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    if (image?.type === "image") expect(Buffer.from(image.data, "base64").byteLength).toBeGreaterThan(0);
    const output = ExportPreviewOutputSchema.parse(call.structuredContent);
    expect(output.outcome.ok).toBe(true);
    expect(JSON.stringify(call.structuredContent)).not.toContain("imageBase64");
  });

  it("uses authenticated HTTP long polling with the same request and response frames", async () => {
    const harness = await startHttpHarness();

    const raw = await harness.bridge.request(
      "document.list",
      { maxDocuments: 5 },
      "44444444-4444-4444-8444-444444444444",
      2_000,
      new AbortController().signal,
    );

    const result = ListDocumentsResultSchema.parse(raw);
    expect(result.documents).toHaveLength(1);
    expect(harness.bridge.status()).toMatchObject({ authenticated: true, transport: "http" });
    expect(harness.client.requests.at(-1)?.method).toBe("document.list");
  });

  it("rejects an invalid HMAC after the bounded per-connection attempt limit", async () => {
    const token = randomBytes(32);
    const wrongToken = randomBytes(32);

    await expect(startWebSocketHarness(new FakeInDesignAdapter(), token, wrongToken, 3))
      .rejects.toThrow(/before authentication/i);

    const registeredCleanup = cleanup.at(-1);
    expect(registeredCleanup).toBeDefined();
  });

  it("reports deadline uncertainty and cancellation while discarding late responses", async () => {
    const adapter = new FakeInDesignAdapter({ delayMsByMethod: { "document.list": 100 } });
    const harness = await startWebSocketHarness(adapter);

    const timedOut = harness.bridge.request(
      "document.list",
      { maxDocuments: 1 },
      "55555555-5555-4555-8555-555555555555",
      20,
      new AbortController().signal,
    );
    await expect(timedOut).rejects.toMatchObject({ code: "TIMEOUT" });

    const controller = new AbortController();
    const cancelled = harness.bridge.request(
      "document.list",
      { maxDocuments: 1 },
      "66666666-6666-4666-8666-666666666666",
      2_000,
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(SolBridgeError);
    await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });

    await delay(25);
    const cancelReasons = harness.client.events
      .filter((event) => event.event === "request.cancel")
      .map((event) => event.payload?.reason);
    expect(cancelReasons).toContain("deadline_exceeded");
    expect(cancelReasons).toContain("mcp_client_cancelled");
  });

  it("returns a parsed error envelope when an authenticated plugin sends malformed status", async () => {
    const harness = await startWebSocketHarness(new InvalidPluginResultAdapter());
    const mcpClient = await connectMcp(harness.bridge, harness.logger);

    const call = await mcpClient.callTool({ name: "indesign_status", arguments: {} });

    expect(call.isError).toBe(true);
    const output = StatusOutputSchema.parse(call.structuredContent);
    expect(output.outcome).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("rejects unsafe preview metadata and never forwards unverified image bytes", async () => {
    const harness = await startWebSocketHarness(new InvalidPluginResultAdapter());
    const mcpClient = await connectMcp(harness.bridge, harness.logger);

    const call = await mcpClient.callTool({
      name: "indesign_export_preview",
      arguments: {
        documentRef: fixtureDocumentRef(),
        expectedRevision: 1,
        pageRef: fixturePageRef(),
        targetPath: "previews/contract.png",
        maxDimensionPx: 1_600,
        overwrite: false,
      },
    });

    expect(call.isError).toBe(true);
    expect(containsImageContent(call.content)).toBe(false);
    const output = ExportPreviewOutputSchema.parse(call.structuredContent);
    expect(output.outcome).toMatchObject({ ok: false, error: { code: "DOM_ERROR" } });
  });

  it("rejects preview dimensions that do not match the PNG IHDR", async () => {
    const harness = await startWebSocketHarness(new ForgedPreviewDimensionsAdapter());
    const mcpClient = await connectMcp(harness.bridge, harness.logger);

    const call = await mcpClient.callTool({
      name: "indesign_export_preview",
      arguments: {
        documentRef: fixtureDocumentRef(),
        expectedRevision: 1,
        pageRef: fixturePageRef(),
        targetPath: "previews/forged-dimensions.png",
        maxDimensionPx: 1_600,
        overwrite: false,
      },
    });

    expect(call.isError).toBe(true);
    expect(containsImageContent(call.content)).toBe(false);
    const output = ExportPreviewOutputSchema.parse(call.structuredContent);
    expect(output.outcome).toMatchObject({ ok: false, error: { code: "DOM_ERROR" } });
  });

  it("returns a PARTIAL_FAILURE envelope instead of reporting a partial batch as success", async () => {
    const harness = await startWebSocketHarness(new PartialFailureAdapter());
    const mcpClient = await connectMcp(harness.bridge, harness.logger);

    const call = await mcpClient.callTool({
      name: "indesign_apply_operations",
      arguments: {
        documentRef: fixtureDocumentRef(),
        expectedRevision: 1,
        operations: [
          { type: "ensure_layer", ref: "layer", name: "Partial Layer" },
          { type: "create_page", ref: "page" },
        ],
        dryRun: false,
      },
    });

    expect(call.isError).toBe(true);
    const output = ApplyOperationsOutputSchema.parse(call.structuredContent);
    expect(output.outcome).toMatchObject({
      ok: false,
      error: {
        code: "PARTIAL_FAILURE",
        details: {
          revision: 2,
          completedOperationCount: 1,
          partialChanges: true,
          undoRecommended: true,
        },
      },
    });
  });
});

function containsImageContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return (value as unknown[]).some((item) => (
    typeof item === "object"
    && item !== null
    && Reflect.get(item, "type") === "image"
  ));
}
