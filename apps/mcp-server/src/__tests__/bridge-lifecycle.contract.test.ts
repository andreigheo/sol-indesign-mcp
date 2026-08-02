import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_PROTOCOL,
  BridgeChallengeSchema,
  BridgeFrameSchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  type BridgeFrame,
} from "@sol/protocol";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../bridge/server.js";
import { JsonLogger } from "../logger.js";
import { createChallengeDigest } from "../token.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function startBridge(
  preHelloTimeoutMs: number,
  token = randomBytes(32),
): Promise<{ bridge: BridgeServer; port: number }> {
  const logDirectory = await mkdtemp(join(tmpdir(), "sol-indesign-lifecycle-"));
  const logger = new JsonLogger(logDirectory);
  const bridge = new BridgeServer({
    host: "127.0.0.1",
    port: 0,
    token,
    logger,
    preHelloTimeoutMs,
  });
  const port = await bridge.start();
  cleanup.push(async () => {
    await bridge.close();
    await logger.flush();
    await rm(logDirectory, { recursive: true, force: true });
  });
  return { bridge, port };
}

const httpHello = {
  protocol: BRIDGE_PROTOCOL,
  type: "hello",
  supportedProtocols: [BRIDGE_PROTOCOL],
  pluginVersion: "0.1.0-test",
  inDesignVersion: "21.4.1-test",
  transport: "http",
  capabilities: {},
} as const;

function openSlowSessionPost(port: number): ClientRequest {
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/bridge/http/session",
    headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
  });
  request.on("error", () => undefined);
  request.flushHeaders();
  request.write("{");
  cleanup.push(() => {
    request.destroy();
    return Promise.resolve();
  });
  return request;
}

async function slowPostResponse(port: number, contentLength?: number): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/bridge/http/session",
      headers: {
        "content-type": "application/json",
        ...(contentLength === undefined
          ? { "transfer-encoding": "chunked" }
          : { "content-length": String(contentLength) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.flushHeaders();
    if (contentLength === undefined) request.write("{");
    cleanup.push(() => {
      request.destroy();
      return Promise.resolve();
    });
  });
}

async function createAuthenticatedHttpSession(port: number, token: Uint8Array): Promise<string> {
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/bridge/http/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(httpHello),
  });
  expect(sessionResponse.status).toBe(201);
  const session: unknown = await sessionResponse.json();
  if (!isRecord(session) || typeof session.clientId !== "string" || !Array.isArray(session.frames)) {
    throw new Error("The HTTP bridge returned an invalid test session envelope.");
  }
  const challenge = BridgeChallengeSchema.parse(session.frames[0]);
  const authentication = {
    protocol: BRIDGE_PROTOCOL,
    type: "authentication",
    sessionId: challenge.sessionId,
    digest: createChallengeDigest(token, challenge.nonce).toString("base64url"),
  } as const;
  const authenticationResponse = await fetch(
    `http://127.0.0.1:${port}/bridge/http/send?clientId=${encodeURIComponent(session.clientId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authentication),
    },
  );
  expect(authenticationResponse.status).toBe(202);
  const authenticatedPoll = await fetch(
    `http://127.0.0.1:${port}/bridge/http/poll?clientId=${encodeURIComponent(session.clientId)}`,
  );
  expect(authenticatedPoll.status).toBe(200);
  const authenticatedFrames = await readPollFrames(authenticatedPoll);
  expect(authenticatedFrames).toContainEqual(expect.objectContaining({ type: "event", event: "authenticated" }));
  return session.clientId;
}

async function readPollFrames(response: Response): Promise<BridgeFrame[]> {
  const body = await response.text();
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BRIDGE_MESSAGE_BYTES);
  const decoded: unknown = JSON.parse(body);
  if (!isRecord(decoded) || !Array.isArray(decoded.frames)) {
    throw new Error("The HTTP bridge returned an invalid poll envelope.");
  }
  return decoded.frames.map((frame) => BridgeFrameSchema.parse(frame));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectSilent(port: number): {
  socket: WebSocket;
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
} {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
  cleanup.push(() => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
    return Promise.resolve();
  });
  return { socket, opened, closed };
}

describe("bridge unauthenticated WebSocket lifecycle", () => {
  it("closes a socket that never sends BridgeHello within the handshake deadline", async () => {
    const { port } = await startBridge(100);
    const client = connectSilent(port);
    await client.opened;
    await expect(client.closed).resolves.toEqual({ code: 1008, reason: "Hello deadline exceeded" });
  });

  it("caps sockets waiting to send BridgeHello and closes safely more than once", async () => {
    const { bridge, port } = await startBridge(5_000);
    const pending = [connectSilent(port), connectSilent(port), connectSilent(port)];
    await Promise.all(pending.map(async (client) => await client.opened));

    const rejected = connectSilent(port);
    await rejected.opened;
    await expect(rejected.closed).resolves.toEqual({ code: 1013, reason: "Authentication capacity reached" });
    expect(pending.every((client) => client.socket.readyState === WebSocket.OPEN)).toBe(true);

    await Promise.all([bridge.close(), bridge.close()]);
  });

  it("can roll back idempotently when bridge startup fails", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => await new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address() as AddressInfo;
    const logDirectory = await mkdtemp(join(tmpdir(), "sol-indesign-startup-rollback-"));
    const logger = new JsonLogger(logDirectory);
    const bridge = new BridgeServer({
      host: "127.0.0.1",
      port: address.port,
      token: randomBytes(32),
      logger,
    });
    cleanup.push(async () => {
      await bridge.close();
      await logger.flush();
      await rm(logDirectory, { recursive: true, force: true });
    });

    await expect(bridge.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(Promise.all([bridge.close(), bridge.close()])).resolves.toEqual([undefined, undefined]);
  });
});

describe("bridge HTTP resource lifecycle", () => {
  it("caps concurrent pre-session bodies before reading a fourth request", async () => {
    const { port } = await startBridge(5_000);
    const slowRequests = [openSlowSessionPost(port), openSlowSessionPost(port), openSlowSessionPost(port)];
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const rejected = await fetch(`http://127.0.0.1:${port}/bridge/http/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(httpHello),
    });
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({ error: "authentication_rate_limited" });
    for (const request of slowRequests) request.destroy();
  });

  it("times out an incomplete pre-session body", async () => {
    const { port } = await startBridge(75);

    const response = await slowPostResponse(port);

    expect(response.statusCode).toBe(408);
    expect(JSON.parse(response.body)).toEqual({ error: "body_timeout" });
  });

  it("rejects an oversized declared pre-session body before it is sent", async () => {
    const { port } = await startBridge(5_000);

    const response = await slowPostResponse(port, MAX_BRIDGE_MESSAGE_BYTES + 1);

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "message_too_large" });
  });

  it("keeps each HTTP poll envelope within 8 MiB and leaves later frames queued", async () => {
    const token = randomBytes(32);
    const { bridge, port } = await startBridge(5_000, token);
    const clientId = await createAuthenticatedHttpSession(port, token);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const payload = "x".repeat(4_300_000);
    const firstPending = bridge.request(
      "document.list",
      { payload },
      "11111111-1111-4111-8111-111111111111",
      5_000,
      firstController.signal,
    ).catch(() => undefined);
    const secondPending = bridge.request(
      "document.list",
      { payload },
      "22222222-2222-4222-8222-222222222222",
      5_000,
      secondController.signal,
    ).catch(() => undefined);

    const firstPoll = await fetch(
      `http://127.0.0.1:${port}/bridge/http/poll?clientId=${encodeURIComponent(clientId)}`,
    );
    const firstFrames = await readPollFrames(firstPoll);
    const secondPoll = await fetch(
      `http://127.0.0.1:${port}/bridge/http/poll?clientId=${encodeURIComponent(clientId)}`,
    );
    const secondFrames = await readPollFrames(secondPoll);

    expect(firstFrames).toHaveLength(1);
    expect(secondFrames).toHaveLength(1);
    expect(firstFrames[0]).toMatchObject({ type: "request", meta: { traceId: "11111111-1111-4111-8111-111111111111" } });
    expect(secondFrames[0]).toMatchObject({ type: "request", meta: { traceId: "22222222-2222-4222-8222-222222222222" } });
    firstController.abort();
    secondController.abort();
    await Promise.all([firstPending, secondPending]);
  });

  it("closes an HTTP session when its bounded outbound byte budget is exhausted", async () => {
    const token = randomBytes(32);
    const { bridge, port } = await startBridge(5_000, token);
    await createAuthenticatedHttpSession(port, token);
    const payload = "x".repeat(5_000_000);
    const requests = Array.from({ length: 7 }, () => bridge.request(
      "document.list",
      { payload },
      randomUUID(),
      5_000,
      new AbortController().signal,
    ).then(
      () => "unexpected_success",
      (error: unknown) => error instanceof Error ? error.message : "unknown_error",
    ));

    const results = await Promise.all(requests);

    expect(results).not.toContain("unexpected_success");
    expect(results.every((message) => message.includes("BRIDGE_BUSY"))).toBe(true);
    expect(bridge.status()).toMatchObject({
      bridgeConnected: false,
      authenticated: false,
      lastErrorCode: "BRIDGE_BUSY",
    });
  });
});
