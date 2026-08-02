import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  BRIDGE_PROTOCOL,
  BridgeAuthenticationSchema,
  BridgeFrameSchema,
  BridgeHelloSchema,
  BridgeResponseSchema,
  MAX_BRIDGE_MESSAGE_BYTES,
  type BridgeAuthentication,
  type BridgeChallenge,
  type BridgeEvent,
  type BridgeFrame,
  type BridgeHello,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  SolBridgeError,
} from "@sol/protocol";
import type { JsonLogger } from "../logger.js";
import { verifyChallengeDigest } from "../token.js";

const AUTH_CHALLENGE_TTL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_CONNECTION_MS = 30_000;
const MAX_PENDING_AUTH = 3;
const MAX_AUTH_FAILURES_PER_CONNECTION = 3;
const MAX_GLOBAL_AUTH_FAILURES_PER_MINUTE = 10;
const MAX_PENDING_REQUESTS = 256;
const MAX_HTTP_OUTBOUND_FRAMES = 512;
const MAX_HTTP_OUTBOUND_BYTES = MAX_BRIDGE_MESSAGE_BYTES * 4;
const HTTP_FRAMES_ENVELOPE_BYTES = Buffer.byteLength('{"frames":[]}');

class HttpBodyReadError extends Error {
  readonly statusCode: 400 | 408 | 413;
  readonly safeCode: "invalid_body" | "body_timeout" | "message_too_large";

  constructor(statusCode: 400 | 408 | 413, safeCode: "invalid_body" | "body_timeout" | "message_too_large") {
    super(safeCode);
    this.name = "HttpBodyReadError";
    this.statusCode = statusCode;
    this.safeCode = safeCode;
  }
}

type TransportKind = "websocket" | "http";
type AuthenticationFailureReason = "challenge_expired" | "session_mismatch" | "digest_mismatch";

interface ConnectionState {
  readonly clientId: string;
  readonly sessionId: string;
  nonce: string;
  challengeExpiresAt: number;
  readonly transport: TransportKind;
  readonly outbound: BridgeFrame[];
  outboundBytes: number;
  readonly pollWaiters: (() => void)[];
  hello: BridgeHello;
  socket?: WebSocket;
  authenticated: boolean;
  authFailures: number;
  lastHeartbeatAt: number;
  lastStatus: Readonly<Record<string, unknown>>;
}

interface PendingRequest {
  readonly resolve: (response: BridgeResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abortListener: () => void;
  readonly signal: AbortSignal;
}

export interface BridgeRuntimeStatus {
  readonly bridgeConnected: boolean;
  readonly authenticated: boolean;
  readonly transport: TransportKind | null;
  readonly pluginVersion: string | null;
  readonly inDesignVersion: string | null;
  readonly lastHeartbeat: string | null;
  readonly lastErrorCode: string | null;
  readonly pluginStatus: Readonly<Record<string, unknown>>;
}

export interface BridgeServerOptions {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly token: Uint8Array;
  readonly logger: JsonLogger;
  /** Test-only override. Production callers use the 15-second handshake deadline. */
  readonly preHelloTimeoutMs?: number;
}

export class BridgeServer {
  readonly #options: BridgeServerOptions;
  readonly #httpServer = createServer();
  readonly #webSocketServer: WebSocketServer;
  readonly #connections = new Map<string, ConnectionState>();
  readonly #preHelloSockets = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #authFailureTimes: number[] = [];
  #active: ConnectionState | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #lastErrorCode: string | null = null;
  #lastAuthenticationFailureReason: AuthenticationFailureReason | null = null;
  #closePromise: Promise<void> | undefined;
  #pendingHttpSessionBodies = 0;

  constructor(options: BridgeServerOptions) {
    this.#options = options;
    this.#webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_MESSAGE_BYTES });
    this.#httpServer.on("request", (request, response) => {
      void this.#handleHttp(request, response);
    });
    this.#httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/bridge") {
        socket.destroy();
        return;
      }
      this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.#webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.#webSocketServer.on("connection", (socket) => this.#handleWebSocket(socket));
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#httpServer.once("error", onError);
      this.#httpServer.listen(this.#options.port, this.#options.host, () => {
        this.#httpServer.off("error", onError);
        resolve();
      });
    });
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref();
    const address = this.#httpServer.address() as AddressInfo | null;
    const port = address?.port ?? this.#options.port;
    this.#options.logger.log("info", "bridge_listening", { host: this.#options.host, port });
    return port;
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close();
    await this.#closePromise;
  }

  status(): BridgeRuntimeStatus {
    const active = this.#active;
    return {
      bridgeConnected: active !== undefined,
      authenticated: active?.authenticated ?? false,
      transport: active?.transport ?? null,
      pluginVersion: active?.hello.pluginVersion ?? null,
      inDesignVersion: active?.hello.inDesignVersion ?? null,
      lastHeartbeat: active === undefined ? null : new Date(active.lastHeartbeatAt).toISOString(),
      lastErrorCode: this.#lastErrorCode,
      pluginStatus: active?.lastStatus ?? {},
    };
  }

  async request(
    method: BridgeMethod,
    params: Readonly<Record<string, unknown>>,
    traceId: string,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const active = this.#active;
    if (!active?.authenticated) {
      throw new SolBridgeError({
        code: "BRIDGE_OFFLINE",
        message: "The InDesign UXP bridge is not connected and authenticated.",
        traceId,
        retryable: true,
      });
    }
    if (signal.aborted) {
      throw new SolBridgeError({ code: "CANCELLED", message: "The request was cancelled before dispatch.", traceId, retryable: false });
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new SolBridgeError({
        code: "BRIDGE_BUSY",
        message: "The InDesign bridge queue is full. Wait for current requests to finish before retrying.",
        traceId,
        retryable: true,
        details: { maxPendingRequests: MAX_PENDING_REQUESTS },
      });
    }
    const id = randomUUID();
    const frame: BridgeRequest = {
      protocol: BRIDGE_PROTOCOL,
      type: "request",
      id,
      method,
      params: { ...params },
      meta: { traceId, deadlineMs },
    };
    if (Buffer.byteLength(JSON.stringify(BridgeFrameSchema.parse(frame))) > MAX_BRIDGE_MESSAGE_BYTES) {
      throw new SolBridgeError({
        code: "MESSAGE_TOO_LARGE",
        message: "The validated request exceeds the 8 MiB bridge frame limit.",
        traceId,
        retryable: false,
        details: { maxBytes: MAX_BRIDGE_MESSAGE_BYTES },
      });
    }
    return await new Promise<unknown>((resolve, reject) => {
      const abortListener = (): void => {
        this.#pending.delete(id);
        clearTimeout(timer);
        this.#send(active, {
          protocol: BRIDGE_PROTOCOL,
          type: "event",
          event: "request.cancel",
          traceId,
          requestId: id,
          payload: { reason: "mcp_client_cancelled" },
        });
        reject(new SolBridgeError({
          code: "CANCELLED",
          message: "Cancellation was requested after dispatch. A synchronous InDesign operation may still have completed.",
          traceId,
          retryable: false,
          details: { cancellationStatus: "requested", operationMayHaveCompleted: true },
        }));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal.removeEventListener("abort", abortListener);
        this.#send(active, {
          protocol: BRIDGE_PROTOCOL,
          type: "event",
          event: "request.cancel",
          traceId,
          requestId: id,
          payload: { reason: "deadline_exceeded" },
        });
        reject(new SolBridgeError({
          code: "TIMEOUT",
          message: "The InDesign request exceeded its deadline. A synchronous DOM operation may still have completed.",
          traceId,
          retryable: true,
          details: { cancellationStatus: "not_guaranteed", operationMayHaveCompleted: true },
        }));
      }, deadlineMs);
      timer.unref();
      this.#pending.set(id, {
        resolve: (response) => response.ok ? resolve(response.result) : reject(new SolBridgeError(response.error)),
        reject,
        timer,
        abortListener,
        signal,
      });
      signal.addEventListener("abort", abortListener, { once: true });
      this.#send(active, frame);
    });
  }

  #handleWebSocket(socket: WebSocket): void {
    this.#pruneExpiredConnections();
    if (
      this.#pendingAuthenticationCount() >= MAX_PENDING_AUTH
      || this.#isGloballyRateLimited()
    ) {
      socket.close(1013, "Authentication capacity reached");
      return;
    }

    const preHelloTimeoutMs = Math.min(
      AUTH_CHALLENGE_TTL_MS,
      Math.max(1, this.#options.preHelloTimeoutMs ?? AUTH_CHALLENGE_TTL_MS),
    );
    const preHelloTimer = setTimeout(() => {
      this.#preHelloSockets.delete(socket);
      if (socket.readyState === WebSocket.OPEN) socket.close(1008, "Hello deadline exceeded");
      else socket.terminate();
    }, preHelloTimeoutMs);
    preHelloTimer.unref();
    this.#preHelloSockets.set(socket, preHelloTimer);

    let connection: ConnectionState | undefined;
    socket.on("message", (raw: RawData) => {
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      const text = data.toString("utf8");
      if (Buffer.byteLength(text) > MAX_BRIDGE_MESSAGE_BYTES) {
        socket.close(1009, "Message too large");
        return;
      }
      let frame: BridgeFrame;
      try {
        frame = BridgeFrameSchema.parse(JSON.parse(text) as unknown);
      } catch {
        socket.close(1007, "Invalid bridge frame");
        return;
      }
      if (connection === undefined) {
        const helloResult = BridgeHelloSchema.safeParse(frame);
        if (!helloResult.success) {
          socket.close(1008, "Hello required");
          return;
        }
        this.#clearPreHelloSocket(socket);
        connection = this.#createConnection(helloResult.data, "websocket", socket);
        if (connection === undefined) {
          socket.close(1013, "Authentication rate limited");
          return;
        }
        this.#send(connection, this.#challenge(connection));
        return;
      }
      this.#processIncoming(connection, frame);
    });
    socket.on("close", () => {
      this.#clearPreHelloSocket(socket);
      if (connection !== undefined) this.#closeConnection(connection, "BRIDGE_OFFLINE");
    });
    socket.on("error", () => {
      this.#clearPreHelloSocket(socket);
      if (connection !== undefined) this.#closeConnection(connection, "BRIDGE_OFFLINE");
    });
  }

  #clearPreHelloSocket(socket: WebSocket): void {
    const timer = this.#preHelloSockets.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.#preHelloSockets.delete(socket);
  }

  #createConnection(hello: BridgeHello, transport: TransportKind, socket?: WebSocket): ConnectionState | undefined {
    this.#pruneExpiredConnections();
    if (!hello.supportedProtocols.includes(BRIDGE_PROTOCOL)) {
      this.#lastErrorCode = "BRIDGE_PROTOCOL_MISMATCH";
      return undefined;
    }
    if (this.#pendingAuthenticationCount() >= MAX_PENDING_AUTH || this.#isGloballyRateLimited()) return undefined;
    const clientId = randomBytes(24).toString("base64url");
    const connection: ConnectionState = {
      clientId,
      sessionId: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      challengeExpiresAt: Date.now() + AUTH_CHALLENGE_TTL_MS,
      transport,
      outbound: [],
      outboundBytes: 0,
      pollWaiters: [],
      hello,
      ...(socket === undefined ? {} : { socket }),
      authenticated: false,
      authFailures: 0,
      lastHeartbeatAt: Date.now(),
      lastStatus: {},
    };
    this.#connections.set(clientId, connection);
    return connection;
  }

  #challenge(connection: ConnectionState): BridgeChallenge {
    return {
      protocol: BRIDGE_PROTOCOL,
      type: "challenge",
      sessionId: connection.sessionId,
      nonce: connection.nonce,
      expiresAt: connection.challengeExpiresAt,
    };
  }

  #processIncoming(connection: ConnectionState, frame: BridgeFrame): void {
    if (!connection.authenticated) {
      const authResult = BridgeAuthenticationSchema.safeParse(frame);
      if (!authResult.success) {
        this.#lastErrorCode = "BRIDGE_AUTH_FAILED";
        this.#closeConnection(connection, "BRIDGE_AUTH_FAILED");
        return;
      }
      if (this.#authenticate(connection, authResult.data)) return;
      if (!this.#connections.has(connection.clientId)) return;
      connection.authFailures += 1;
      this.#authFailureTimes.push(Date.now());
      this.#lastErrorCode = "BRIDGE_AUTH_FAILED";
      this.#options.logger.log("warn", "bridge_auth_failed", {
        transport: connection.transport,
        failureCount: connection.authFailures,
        reason: this.#lastAuthenticationFailureReason ?? "unknown",
      });
      if (connection.authFailures >= MAX_AUTH_FAILURES_PER_CONNECTION || this.#isGloballyRateLimited()) {
        this.#closeConnection(connection, "BRIDGE_AUTH_FAILED");
        return;
      }
      connection.nonce = randomBytes(32).toString("base64url");
      connection.challengeExpiresAt = Date.now() + AUTH_CHALLENGE_TTL_MS;
      this.#send(connection, this.#challenge(connection));
      return;
    }
    connection.lastHeartbeatAt = Date.now();
    const responseResult = BridgeResponseSchema.safeParse(frame);
    if (responseResult.success) {
      const pending = this.#pending.get(responseResult.data.id);
      if (pending !== undefined) {
        this.#pending.delete(responseResult.data.id);
        clearTimeout(pending.timer);
        pending.signal.removeEventListener("abort", pending.abortListener);
        pending.resolve(responseResult.data);
      }
      return;
    }
    if (frame.type === "event") {
      if (frame.event === "status") connection.lastStatus = frame.payload ?? {};
      if (frame.event === "heartbeat") {
        this.#send(connection, { protocol: BRIDGE_PROTOCOL, type: "event", event: "heartbeat_ack" });
      }
    }
  }

  #authenticate(connection: ConnectionState, frame: BridgeAuthentication): boolean {
    if (Date.now() > connection.challengeExpiresAt) {
      this.#lastAuthenticationFailureReason = "challenge_expired";
      return false;
    }
    if (frame.sessionId !== connection.sessionId) {
      this.#lastAuthenticationFailureReason = "session_mismatch";
      return false;
    }
    if (!verifyChallengeDigest(this.#options.token, connection.nonce, frame.digest)) {
      this.#lastAuthenticationFailureReason = "digest_mismatch";
      return false;
    }
    if (this.#active !== undefined && this.#active !== connection && Date.now() - this.#active.lastHeartbeatAt <= STALE_CONNECTION_MS) {
      this.#lastAuthenticationFailureReason = null;
      this.#lastErrorCode = "BRIDGE_ALREADY_CONNECTED";
      this.#closeConnection(connection, "BRIDGE_ALREADY_CONNECTED");
      return false;
    }
    if (this.#active !== undefined && this.#active !== connection) this.#closeConnection(this.#active, "BRIDGE_OFFLINE");
    connection.authenticated = true;
    this.#lastAuthenticationFailureReason = null;
    connection.lastHeartbeatAt = Date.now();
    this.#active = connection;
    this.#lastErrorCode = null;
    this.#send(connection, { protocol: BRIDGE_PROTOCOL, type: "event", event: "authenticated" });
    this.#options.logger.log("info", "bridge_authenticated", { transport: connection.transport, pluginVersion: connection.hello.pluginVersion });
    return true;
  }

  #send(connection: ConnectionState, frame: BridgeFrame): void {
    const serialized = JSON.stringify(BridgeFrameSchema.parse(frame));
    if (Buffer.byteLength(serialized) > MAX_BRIDGE_MESSAGE_BYTES) {
      this.#lastErrorCode = "MESSAGE_TOO_LARGE";
      this.#closeConnection(connection, "MESSAGE_TOO_LARGE");
      return;
    }
    if (connection.transport === "websocket" && connection.socket?.readyState === WebSocket.OPEN) {
      connection.socket.send(serialized);
      return;
    }
    if (HTTP_FRAMES_ENVELOPE_BYTES + Buffer.byteLength(serialized) > MAX_BRIDGE_MESSAGE_BYTES) {
      this.#lastErrorCode = "MESSAGE_TOO_LARGE";
      this.#closeConnection(connection, "MESSAGE_TOO_LARGE");
      return;
    }
    const serializedBytes = Buffer.byteLength(serialized);
    if (
      connection.outbound.length >= MAX_HTTP_OUTBOUND_FRAMES
      || connection.outboundBytes + serializedBytes > MAX_HTTP_OUTBOUND_BYTES
    ) {
      this.#lastErrorCode = "BRIDGE_BUSY";
      this.#closeConnection(connection, "BRIDGE_BUSY");
      return;
    }
    connection.outbound.push(frame);
    connection.outboundBytes += serializedBytes;
    for (const waiter of connection.pollWaiters.splice(0)) waiter();
  }

  #heartbeat(): void {
    this.#pruneExpiredConnections();
    const active = this.#active;
    if (active === undefined) return;
    if (Date.now() - active.lastHeartbeatAt > STALE_CONNECTION_MS) {
      this.#closeConnection(active, "BRIDGE_OFFLINE");
      return;
    }
    const heartbeat: BridgeEvent = { protocol: BRIDGE_PROTOCOL, type: "event", event: "heartbeat" };
    this.#send(active, heartbeat);
  }

  #closeConnection(connection: ConnectionState, errorCode: string): void {
    this.#connections.delete(connection.clientId);
    if (this.#active === connection) {
      this.#active = undefined;
      this.#lastErrorCode = errorCode;
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.signal.removeEventListener("abort", pending.abortListener);
        pending.reject(new Error(`Bridge connection closed (${errorCode})`));
        this.#pending.delete(id);
      }
    }
    for (const waiter of connection.pollWaiters.splice(0)) waiter();
    connection.outbound.splice(0);
    connection.outboundBytes = 0;
    if (connection.socket?.readyState === WebSocket.OPEN) connection.socket.close(1000, "Bridge session closed");
  }

  #pruneExpiredConnections(): void {
    const now = Date.now();
    for (const connection of this.#connections.values()) {
      if (!connection.authenticated && now > connection.challengeExpiresAt) this.#closeConnection(connection, "BRIDGE_AUTH_FAILED");
    }
    while (this.#authFailureTimes.length > 0 && (this.#authFailureTimes[0] ?? now) < now - 60_000) this.#authFailureTimes.shift();
  }

  #isGloballyRateLimited(): boolean {
    this.#pruneExpiredConnections();
    return this.#authFailureTimes.length >= MAX_GLOBAL_AUTH_FAILURES_PER_MINUTE;
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      const status = this.status();
      this.#json(response, 200, {
        server: "sol-indesign-mcp",
        bridgeConnected: status.bridgeConnected,
        authenticated: status.authenticated,
        transport: status.transport,
        lastErrorCode: status.lastErrorCode,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/bridge/http/session") {
      this.#pruneExpiredConnections();
      if (this.#pendingAuthenticationCount() >= MAX_PENDING_AUTH || this.#isGloballyRateLimited()) {
        this.#rejectHttpBody(request, response, 429, "authentication_rate_limited");
        return;
      }
      let hello: BridgeHello;
      this.#pendingHttpSessionBodies += 1;
      try {
        hello = BridgeHelloSchema.parse(await this.#readJson(request, this.#handshakeDeadlineMs()));
      } catch (error: unknown) {
        if (error instanceof HttpBodyReadError) this.#rejectHttpBody(request, response, error.statusCode, error.safeCode);
        else this.#json(response, 400, { error: "invalid_hello" });
        return;
      } finally {
        this.#pendingHttpSessionBodies -= 1;
      }
      const connection = this.#createConnection(hello, "http");
      if (connection === undefined) { this.#json(response, 429, { error: "authentication_rate_limited" }); return; }
      this.#json(response, 201, { clientId: connection.clientId, frames: [this.#challenge(connection)] });
      return;
    }
    const clientId = url.searchParams.get("clientId");
    const connection = clientId === null ? undefined : this.#connections.get(clientId);
    if (connection?.transport !== "http") {
      this.#json(response, 404, { error: "unknown_session" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/bridge/http/send") {
      let frame: BridgeFrame;
      try { frame = BridgeFrameSchema.parse(await this.#readJson(request, AUTH_CHALLENGE_TTL_MS)); }
      catch (error: unknown) {
        if (error instanceof HttpBodyReadError) this.#rejectHttpBody(request, response, error.statusCode, error.safeCode);
        else this.#json(response, 400, { error: "invalid_frame" });
        return;
      }
      this.#processIncoming(connection, frame);
      this.#json(response, 202, { accepted: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/bridge/http/poll") {
      if (connection.outbound.length === 0) {
        if (connection.pollWaiters.length > 0) {
          this.#json(response, 409, { error: "poll_already_pending" });
          return;
        }
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer);
            const index = connection.pollWaiters.indexOf(finish);
            if (index >= 0) connection.pollWaiters.splice(index, 1);
            resolve();
          };
          const timer = setTimeout(finish, 25_000);
          connection.pollWaiters.push(finish);
        });
      }
      const frames = this.#dequeueHttpBatch(connection);
      this.#json(response, 200, { frames });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/bridge/http/session") {
      this.#closeConnection(connection, "BRIDGE_OFFLINE");
      response.writeHead(204).end();
      return;
    }
    this.#json(response, 404, { error: "not_found" });
  }

  async #readJson(request: IncomingMessage, deadlineMs: number): Promise<unknown> {
    const contentLength = request.headers["content-length"];
    if (Array.isArray(contentLength)) throw new HttpBodyReadError(400, "invalid_body");
    if (contentLength !== undefined) {
      if (!/^\d+$/u.test(contentLength)) throw new HttpBodyReadError(400, "invalid_body");
      const declaredBytes = Number(contentLength);
      if (!Number.isSafeInteger(declaredBytes)) throw new HttpBodyReadError(413, "message_too_large");
      if (declaredBytes > MAX_BRIDGE_MESSAGE_BYTES) throw new HttpBodyReadError(413, "message_too_large");
    }

    return await new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("aborted", onAborted);
        request.off("error", onError);
      };
      const rejectOnce = (error: HttpBodyReadError): void => {
        if (settled) return;
        settled = true;
        request.pause();
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer | Uint8Array): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_BRIDGE_MESSAGE_BYTES) {
          rejectOnce(new HttpBodyReadError(413, "message_too_large"));
          return;
        }
        chunks.push(buffer);
      };
      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          reject(new HttpBodyReadError(400, "invalid_body"));
        }
      };
      const onAborted = (): void => rejectOnce(new HttpBodyReadError(400, "invalid_body"));
      const onError = (): void => rejectOnce(new HttpBodyReadError(400, "invalid_body"));
      const timer = setTimeout(() => rejectOnce(new HttpBodyReadError(408, "body_timeout")), deadlineMs);
      timer.unref();
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("aborted", onAborted);
      request.once("error", onError);
    });
  }

  #dequeueHttpBatch(connection: ConnectionState): BridgeFrame[] {
    const frames: BridgeFrame[] = [];
    let responseBytes = HTTP_FRAMES_ENVELOPE_BYTES;
    while (connection.outbound.length > 0) {
      const next = connection.outbound[0];
      if (next === undefined) break;
      const serialized = JSON.stringify(BridgeFrameSchema.parse(next));
      const additionalBytes = Buffer.byteLength(serialized) + (frames.length === 0 ? 0 : 1);
      if (responseBytes + additionalBytes > MAX_BRIDGE_MESSAGE_BYTES) break;
      frames.push(next);
      connection.outbound.shift();
      connection.outboundBytes = Math.max(0, connection.outboundBytes - Buffer.byteLength(serialized));
      responseBytes += additionalBytes;
    }
    return frames;
  }

  #pendingAuthenticationCount(): number {
    const challenged = [...this.#connections.values()].filter((item) => !item.authenticated).length;
    return this.#preHelloSockets.size + this.#pendingHttpSessionBodies + challenged;
  }

  #handshakeDeadlineMs(): number {
    return Math.min(AUTH_CHALLENGE_TTL_MS, Math.max(1, this.#options.preHelloTimeoutMs ?? AUTH_CHALLENGE_TTL_MS));
  }

  #rejectHttpBody(
    request: IncomingMessage,
    response: ServerResponse,
    statusCode: 400 | 408 | 413 | 429,
    safeCode: string,
  ): void {
    request.pause();
    response.setHeader("Connection", "close");
    response.once("finish", () => request.destroy());
    this.#json(response, statusCode, { error: safeCode });
  }

  #json(response: ServerResponse, statusCode: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    response.end(body);
  }

  async #close(): Promise<void> {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    for (const [socket, timer] of this.#preHelloSockets) {
      clearTimeout(timer);
      socket.terminate();
    }
    this.#preHelloSockets.clear();
    for (const connection of [...this.#connections.values()]) this.#closeConnection(connection, "BRIDGE_OFFLINE");
    for (const socket of this.#webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve) => this.#webSocketServer.close(() => resolve()));
    if (this.#httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        this.#httpServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  }
}
