import { BoundedDetailsSchema } from "@sol/protocol";
import type { Capability } from "@sol/protocol";
import { computeChallengeDigest } from "@sol/security/uxp";
import { SafeBridgeError, toSafeError } from "../core/errors";
import type { DiagnosticRing } from "../diagnostics/diagnostic-ring";
import type { SecretStore } from "../security/secret-store";
import { BridgeHandshakeState } from "./handshake-state";
import { HttpPollingBridgeTransport } from "./http-poll-transport";
import { BRIDGE_PROTOCOL, isFrameType } from "./protocol";
import type { BridgeAuthentication, BridgeEvent, BridgeFrame, BridgeHello } from "./protocol";
import type { BridgeRequestRouter } from "./router";
import type { BridgeTransport, TransportKind } from "./transport";
import { WebSocketBridgeTransport } from "./websocket-transport";

const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_AFTER_MS = 30_000;
const AUTH_TIMEOUT_MS = 15_000;
const HMAC_SELF_TEST_TOKEN = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HMAC_SELF_TEST_NONCE = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const HMAC_SELF_TEST_DIGEST = "HTnaKRqCdzA0ClJsKMnqW1K3geYWtfVE45Wpaoxz8JA";
let hmacSelfTestPassed = false;

export type BridgePhase = "offline" | "connecting" | "authenticating" | "authenticated" | "error";

export interface BridgeClientState {
  phase: BridgePhase;
  transport: TransportKind | undefined;
  authenticated: boolean;
  lastHeartbeat: string | undefined;
  lastError: string | undefined;
}

export interface HelloSnapshot {
  inDesignVersion: string;
  capabilities: Record<string, Capability>;
}

export class BridgeClient {
  readonly #secrets: Pick<SecretStore, "getToken">;
  readonly #router: Pick<BridgeRequestRouter, "handle" | "statusPayload" | "cancel">;
  readonly #diagnostics: Pick<DiagnosticRing, "add">;
  readonly #helloSnapshot: () => Promise<HelloSnapshot>;
  readonly #stateChanged: (state: BridgeClientState) => void;
  readonly #transportFactory: (useHttp: boolean) => BridgeTransport;
  #state: BridgeClientState = { phase: "offline", transport: undefined, authenticated: false, lastHeartbeat: undefined, lastError: undefined };
  #transport: BridgeTransport | undefined;
  #desired = false;
  #manualDisconnect = false;
  #webSocketSessionFailures = 0;
  #reconnectAttempt = 0;
  #generation = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #authTimer: ReturnType<typeof setTimeout> | undefined;
  #restartInProgress = false;
  #connectionStartInProgress = false;
  #runtimeTraceCount = 0;
  readonly #handshake = new BridgeHandshakeState();

  constructor(options: {
    secrets: Pick<SecretStore, "getToken">;
    router: Pick<BridgeRequestRouter, "handle" | "statusPayload" | "cancel">;
    diagnostics: Pick<DiagnosticRing, "add">;
    helloSnapshot: () => Promise<HelloSnapshot>;
    stateChanged: (state: BridgeClientState) => void;
    transportFactory?: (useHttp: boolean) => BridgeTransport;
  }) {
    this.#secrets = options.secrets;
    this.#router = options.router;
    this.#diagnostics = options.diagnostics;
    this.#helloSnapshot = options.helloSnapshot;
    this.#stateChanged = options.stateChanged;
    this.#transportFactory = options.transportFactory
      ?? ((useHttp) => useHttp ? new HttpPollingBridgeTransport() : new WebSocketBridgeTransport());
  }

  state(): BridgeClientState {
    return { ...this.#state };
  }

  start(explicit = false): void {
    this.#trace(`bridge.start explicit=${explicit}`);
    if (this.#manualDisconnect && !explicit) return;
    this.#desired = true;
    if (explicit) {
      this.#manualDisconnect = false;
      this.#reconnectAttempt = 0;
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (explicit && this.#transport !== undefined && !this.#state.authenticated) {
      if (!this.#restartInProgress) void this.#restartPendingConnection();
      return;
    }
    if (!this.#restartInProgress && this.#transport === undefined && this.#reconnectTimer === undefined) void this.#connect();
  }

  async stop(): Promise<void> {
    this.#desired = false;
    this.#manualDisconnect = true;
    this.#generation += 1;
    this.#handshake.reset();
    this.#clearTimers();
    const transport = this.#transport;
    this.#transport = undefined;
    try {
      await transport?.close();
    } catch {
      this.#diagnostics.add("warning", "bridge.transport-close-failed", { transport: transport?.kind });
    }
    this.#setState({ phase: "offline", transport: undefined, authenticated: false, lastHeartbeat: undefined, lastError: undefined });
    this.#diagnostics.add("info", "bridge.disconnected", { manual: true });
  }

  async #connect(): Promise<void> {
    if (!this.#canBeginTransport() || this.#connectionStartInProgress) return;
    this.#connectionStartInProgress = true;
    this.#trace("bridge.connect.begin");
    let token: string | undefined;
    try {
      token = await this.#secrets.getToken();
    } catch (error: unknown) {
      this.#connectionStartInProgress = false;
      this.#trace(`bridge.token.failed code=${toSafeError(error).code}`);
      this.#reportError(error);
      return;
    }
    this.#connectionStartInProgress = false;
    if (!this.#canBeginTransport()) return;
    if (token === undefined) {
      this.#trace("bridge.token.missing");
      this.#setState({ phase: "offline", authenticated: false, lastError: "Pair a token before connecting." });
      return;
    }
    const generation = ++this.#generation;
    const useHttp = this.#webSocketSessionFailures >= 3;
    const transport = this.#transportFactory(useHttp);
    this.#trace(`bridge.transport.selected kind=${transport.kind} wsFailures=${this.#webSocketSessionFailures}`);
    this.#transport = transport;
    this.#handshake.begin();
    this.#setState({ phase: "connecting", transport: transport.kind, authenticated: false, lastError: undefined });
    this.#authTimer = setTimeout(() => {
      if (!this.#state.authenticated) void this.#sessionClosed("Authentication timed out.", generation);
    }, AUTH_TIMEOUT_MS);
    try {
      this.#trace("bridge.snapshot.begin");
      const snapshot = await this.#helloSnapshot();
      this.#trace("bridge.snapshot.ready");
      const hello: BridgeHello = {
        protocol: BRIDGE_PROTOCOL,
        type: "hello",
        supportedProtocols: [BRIDGE_PROTOCOL],
        pluginVersion: __SOL_PLUGIN_VERSION__,
        inDesignVersion: snapshot.inDesignVersion,
        transport: transport.kind === "websocket" ? "websocket" : "http",
        capabilities: snapshot.capabilities,
      };
      await transport.connect(hello, {
        onFrame: (frame) => this.#handleFrame(frame, token, generation, transport),
        onClose: (reason) => { void this.#sessionClosed(reason, generation); },
        onError: (error) => this.#reportError(error),
      });
      if (generation !== this.#generation) return;
      this.#trace(`bridge.transport.open kind=${transport.kind}`);
      this.#setState({ phase: "authenticating" });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#transport = undefined;
      this.#handshake.reset();
      clearTimeout(this.#authTimer);
      this.#authTimer = undefined;
      if (transport.kind === "websocket") this.#webSocketSessionFailures += 1;
      this.#trace(`bridge.connect.failed kind=${transport.kind} code=${toSafeError(error).code} reason=${runtimeErrorSummary(error)}`);
      this.#reportError(error);
      try {
        await transport.close();
      } catch {
        this.#diagnostics.add("warning", "bridge.transport-close-failed", { transport: transport.kind });
      }
      this.#scheduleReconnect();
    }
  }

  async #handleFrame(frame: BridgeFrame, token: string, generation: number, transport: BridgeTransport): Promise<void> {
    if (generation !== this.#generation || this.#transport !== transport) return;
    if (isFrameType(frame, "challenge")) {
      if (frame.expiresAt <= Date.now()) throw new SafeBridgeError("AUTHENTICATION_FAILED", "The bridge authentication challenge expired.");
      const retry = this.#handshake.phase === "authentication_sent";
      assertHmacRuntime();
      const digest = computeChallengeDigest(token, frame.nonce);
      this.#handshake.acceptChallenge();
      const authentication: BridgeAuthentication = {
        protocol: BRIDGE_PROTOCOL,
        type: "authentication",
        sessionId: frame.sessionId,
        digest,
      };
      await transport.send(authentication);
      if (retry) this.#diagnostics.add("warning", "bridge.authentication-retry");
      this.#setState({ phase: "authenticating" });
      return;
    }
    if (isFrameType(frame, "event")) {
      await this.#handleEvent(frame);
      return;
    }
    if (isFrameType(frame, "request")) {
      if (!this.#handshake.authenticated || !this.#state.authenticated) {
        throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The bridge sent work before authentication completed.");
      }
      const response = await this.#router.handle(frame);
      if (generation !== this.#generation || this.#transport !== transport) {
        this.#diagnostics.add("warning", "bridge.response-dropped", { requestId: frame.id, reason: "session_changed" });
        return;
      }
      await transport.send(response);
      await this.#sendStatus();
      return;
    }
    if (isFrameType(frame, "error")) {
      this.#setState({ phase: "error", lastError: frame.message });
      this.#diagnostics.add("error", "bridge.protocol-error", { code: frame.code, retryable: frame.retryable });
      throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The local bridge closed the session with a protocol error.", { retryable: frame.retryable });
    }
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", `Unexpected bridge frame '${frame.type}'.`);
  }

  async #handleEvent(frame: BridgeEvent): Promise<void> {
    if (frame.event === "authenticated") {
      this.#handshake.acceptAuthenticatedEvent();
      clearTimeout(this.#authTimer);
      this.#authTimer = undefined;
      this.#webSocketSessionFailures = 0;
      this.#reconnectAttempt = 0;
      this.#setState({ phase: "authenticated", authenticated: true, lastError: undefined, lastHeartbeat: new Date().toISOString() });
      this.#trace(`bridge.authenticated kind=${this.#transport?.kind ?? "none"}`);
      this.#diagnostics.add("info", "bridge.authenticated", { transport: this.#transport?.kind });
      this.#startHeartbeat();
      await this.#sendStatus();
      return;
    }
    if (!this.#state.authenticated) throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The bridge sent an event before authentication completed.");
    if (frame.event === "heartbeat") {
      const now = new Date().toISOString();
      this.#setState({ lastHeartbeat: now });
      const transport = this.#transport;
      if (transport === undefined) throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The authenticated bridge transport is unavailable.");
      await transport.send({ protocol: BRIDGE_PROTOCOL, type: "event", event: "heartbeat_ack", payload: { timestamp: now } });
      await this.#sendStatus();
      return;
    }
    if (frame.event === "heartbeat_ack") {
      this.#setState({ lastHeartbeat: new Date().toISOString() });
      return;
    }
    if (frame.event === "request.cancel" && frame.requestId !== undefined) {
      this.#router.cancel(frame.requestId);
    }
  }

  #startHeartbeat(): void {
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#state.authenticated) return;
      const last = this.#state.lastHeartbeat === undefined ? 0 : Date.parse(this.#state.lastHeartbeat);
      if (Date.now() - last > STALE_AFTER_MS) {
        void this.#sessionClosed("The bridge heartbeat became stale.", this.#generation);
        return;
      }
      const event: BridgeEvent = {
        protocol: BRIDGE_PROTOCOL,
        type: "event",
        event: "heartbeat",
        payload: { timestamp: new Date().toISOString() },
      };
      void this.#transport?.send(event).catch((error: unknown) => this.#reportError(error));
    }, HEARTBEAT_INTERVAL_MS);
  }

  async #sendStatus(): Promise<void> {
    if (!this.#state.authenticated) return;
    try {
      const status = await this.#router.statusPayload();
      const payload = BoundedDetailsSchema.parse(status);
      await this.#transport?.send({
        protocol: BRIDGE_PROTOCOL,
        type: "event",
        event: "status",
        payload,
      });
    } catch (error: unknown) {
      const safe = toSafeError(error);
      this.#diagnostics.add("warning", "bridge.status-unavailable", { code: safe.code });
    }
  }

  async #sessionClosed(reason: string, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    const wasAuthenticated = this.#state.authenticated;
    const transport = this.#transport;
    this.#transport = undefined;
    this.#generation += 1;
    this.#handshake.reset();
    this.#clearTimers();
    if (!wasAuthenticated && transport?.kind === "websocket") this.#webSocketSessionFailures += 1;
    try {
      await transport?.close();
    } catch {
      this.#diagnostics.add("warning", "bridge.transport-close-failed", { transport: transport?.kind });
    }
    this.#setState({ phase: "offline", authenticated: false, lastError: reason });
    this.#diagnostics.add("warning", "bridge.session-closed", { reason, transport: transport?.kind });
    this.#scheduleReconnect();
  }

  async #restartPendingConnection(): Promise<void> {
    this.#restartInProgress = true;
    const transport = this.#transport;
    this.#transport = undefined;
    this.#generation += 1;
    this.#handshake.reset();
    this.#clearTimers();
    if (transport?.kind === "websocket") this.#webSocketSessionFailures += 1;
    try {
      await transport?.close();
    } catch {
      // A failed UXP transport close must not suppress an explicit retry.
    } finally {
      this.#restartInProgress = false;
    }
    if (this.#desired && !this.#manualDisconnect) void this.#connect();
  }

  #scheduleReconnect(): void {
    if (!this.#desired || this.#manualDisconnect || this.#reconnectTimer !== undefined) return;
    const delay = reconnectDelay(this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
  }

  #reportError(error: unknown): void {
    const safe = toSafeError(error);
    this.#setState({ phase: "error", lastError: safe.message });
    this.#diagnostics.add("error", "bridge.error", { code: safe.code, retryable: safe.retryable });
  }

  #setState(patch: Partial<BridgeClientState>): void {
    this.#state = { ...this.#state, ...patch };
    try {
      this.#stateChanged(this.state());
    } catch {
      // A host DOM rendering quirk must not stop the authenticated transport.
      this.#diagnostics.add("warning", "panel.render-failed");
    }
  }

  #clearTimers(): void {
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#authTimer);
    clearInterval(this.#heartbeatTimer);
    this.#reconnectTimer = undefined;
    this.#authTimer = undefined;
    this.#heartbeatTimer = undefined;
  }

  #trace(message: string): void {
    if (this.#runtimeTraceCount >= 40) return;
    this.#runtimeTraceCount += 1;
    console.log(`[sol-indesign-mcp] ${message}`);
  }

  #canBeginTransport(): boolean {
    return this.#desired && this.#transport === undefined;
  }
}

function assertHmacRuntime(): void {
  if (hmacSelfTestPassed) return;
  if (computeChallengeDigest(HMAC_SELF_TEST_TOKEN, HMAC_SELF_TEST_NONCE) !== HMAC_SELF_TEST_DIGEST) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "This InDesign UXP runtime could not verify the bridge authentication primitive.",
    );
  }
  hmacSelfTestPassed = true;
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(15_000, 500 * (2 ** Math.min(attempt, 5)));
  return Math.max(500, Math.floor(ceiling * (0.65 + random() * 0.35)));
}

function runtimeErrorSummary(error: unknown): string {
  if (!(error instanceof Error)) return `non-error-${typeof error}`;
  const name = boundedLogText(error.name, 48) || "Error";
  const message = boundedLogText(error.message, 160) || "no-message";
  return `${name}:${message}`;
}

function boundedLogText(value: string, maximum: number): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    output += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }
  return output.trim().slice(0, maximum);
}
