import { app } from "indesign";
import { entrypoints } from "uxp";
import { SolInDesignAdapter } from "./adapter/indesign-adapter";
import { BridgeClient } from "./bridge/client";
import type { BridgeClientState, HelloSnapshot } from "./bridge/client";
import { BridgeRequestRouter } from "./bridge/router";
import { DiagnosticRing } from "./diagnostics/diagnostic-ring";
import { SerialRequestQueue } from "./queue/serial-request-queue";
import { SecretStore } from "./security/secret-store";
import { WorkspaceManager } from "./security/workspace";

class PanelController {
  readonly #diagnostics = new DiagnosticRing();
  readonly #secrets = new SecretStore();
  readonly #workspace = new WorkspaceManager();
  readonly #queue = new SerialRequestQueue((depth) => this.#setText("queue-state", `Queue ${depth}`));
  readonly #adapter = new SolInDesignAdapter(app, this.#workspace, this.#diagnostics, {
    onActiveDocument: (name, revision) => this.#showDocument(name, revision),
  });
  readonly #router = new BridgeRequestRouter(this.#adapter, this.#queue, this.#diagnostics);
  #cachedHelloSnapshot: HelloSnapshot | undefined;
  readonly #client = new BridgeClient({
    secrets: this.#secrets,
    router: this.#router,
    diagnostics: this.#diagnostics,
    helloSnapshot: () => this.#getHelloSnapshot(),
    stateChanged: (state) => this.#renderBridgeState(state),
  });
  #initialization: Promise<void> | undefined;
  #pairing = false;

  initialize(): Promise<void> {
    if (this.#initialization !== undefined) return this.#initialization;
    this.#initialization = this.#initializeOnce().catch((error: unknown) => {
      console.log("[sol-indesign-mcp] panel.initialization-failed");
      this.#diagnostics.add("error", "panel.initialization-failed");
      try {
        this.#showError(error instanceof Error ? error.message : "The panel could not finish initializing.");
      } catch {
        // The host renderer itself may be unavailable during panel teardown.
      }
    });
    return this.#initialization;
  }

  async #initializeOnce(): Promise<void> {
    this.#setText("plugin-version", `v${__SOL_PLUGIN_VERSION__}`);
    this.#bindEvents();
    console.log(`[sol-indesign-mcp] panel.initialized v${__SOL_PLUGIN_VERSION__}`);
    let paired = false;
    try {
      paired = await this.#secrets.hasToken();
    } catch (error) {
      this.#showError(error instanceof Error ? error.message : "Secure token storage is unavailable.");
      this.#diagnostics.add("error", "authentication.restore-failed");
    }
    this.#renderAuthentication(paired);

    let workspace = this.#workspace.status();
    try {
      workspace = await this.#workspace.restore();
    } catch (error) {
      this.#showError(error instanceof Error ? error.message : "Workspace authorization could not be restored.");
      this.#diagnostics.add("error", "workspace.restore-failed");
    }
    this.#renderWorkspace(workspace);
    await this.#refreshDocument();
    this.#diagnostics.add("info", "panel.loaded", { version: __SOL_PLUGIN_VERSION__ });
    if (paired) this.#client.start();
  }

  show(): void {
    void this.initialize().then(() => this.#client.start());
  }

  async destroy(): Promise<void> {
    await this.#client.stop();
  }

  #bindEvents(): void {
    const tokenInput = this.#element<HTMLInputElement>("token-input");
    this.#element<HTMLButtonElement>("pair-token-button").addEventListener("click", (event) => {
      event.preventDefault();
      void this.#pairToken();
    });
    tokenInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.#pairToken();
    });
    this.#element<HTMLButtonElement>("connect-button").addEventListener("click", () => {
      console.log("[sol-indesign-mcp] bridge.connect-requested");
      this.#setEvent("Connect requested. Opening the local bridge…");
      this.#diagnostics.add("info", "bridge.connect-requested");
      this.#client.start(true);
    });
    this.#element<HTMLButtonElement>("disconnect-button").addEventListener("click", () => { void this.#client.stop(); });
    this.#element<HTMLButtonElement>("workspace-button").addEventListener("click", () => { void this.#selectWorkspace(); });
    this.#element<HTMLButtonElement>("clear-workspace-button").addEventListener("click", () => {
      this.#renderWorkspace(this.#workspace.clear());
      this.#setEvent("Workspace authorization cleared. Select a folder before file operations.");
      this.#diagnostics.add("info", "workspace.cleared");
    });
    this.#element<HTMLButtonElement>("copy-diagnostics-button").addEventListener("click", () => { void this.#copyDiagnostics(); });
  }

  async #pairToken(): Promise<void> {
    if (this.#pairing) return;
    console.log("[sol-indesign-mcp] authentication.pair-requested");
    const input = this.#element<HTMLInputElement>("token-input");
    const button = this.#element<HTMLButtonElement>("pair-token-button");
    const token = input.value;
    input.value = "";
    this.#pairing = true;
    button.disabled = true;
    this.#clearError();
    this.#setEvent("Storing pairing token…");
    try {
      await this.#secrets.setToken(token);
      console.log("[sol-indesign-mcp] authentication.pair-stored");
      this.#renderAuthentication(true);
      this.#setEvent("Pairing token stored.");
      this.#diagnostics.add("info", "authentication.paired");
      this.#client.start(true);
    } catch (error) {
      console.log(`[sol-indesign-mcp] authentication.pair-failed kind=${error instanceof Error ? error.name : typeof error}`);
      this.#setEvent("Pairing failed. Paste the token and try again.");
      this.#showError(error instanceof Error ? error.message : "The pairing token could not be stored.");
    } finally {
      this.#pairing = false;
      button.disabled = false;
    }
  }

  async #selectWorkspace(): Promise<void> {
    try {
      const status = await this.#workspace.authorize();
      this.#renderWorkspace(status);
      this.#setEvent(`Workspace '${status.name ?? "folder"}' authorized.`);
      this.#diagnostics.add("info", "workspace.authorized", { name: status.name });
    } catch (error) {
      this.#showError(error instanceof Error ? error.message : "Workspace selection was cancelled or failed.");
    }
  }

  async #copyDiagnostics(): Promise<void> {
    try {
      await this.#diagnostics.copy({
        pluginVersion: __SOL_PLUGIN_VERSION__,
        bridge: this.#client.state(),
        workspace: this.#workspace.status(),
        queueDepth: this.#queue.depth,
      });
      this.#setEvent("Diagnostic information copied to the clipboard.");
    } catch (error) {
      this.#showError(error instanceof Error ? error.message : "Diagnostic information could not be copied.");
    }
  }

  async #refreshDocument(): Promise<void> {
    try {
      const active = await this.#queue.enqueue(createLocalId(), 2_000, () => this.#adapter.activeDocumentSummary());
      if (active === null) this.#showDocument(undefined, undefined);
    } catch {
      this.#showDocument(undefined, undefined);
    }
  }

  async #getHelloSnapshot(): Promise<HelloSnapshot> {
    if (this.#cachedHelloSnapshot !== undefined) return this.#cachedHelloSnapshot;
    const snapshot = await this.#queue.enqueue(createLocalId(), 3_000, () => ({
      inDesignVersion: this.#adapter.inDesignVersion(),
      capabilities: this.#adapter.capabilities(),
    }));
    this.#cachedHelloSnapshot = snapshot;
    return snapshot;
  }

  #renderBridgeState(state: BridgeClientState): void {
    const bridgeNode = document.querySelector<HTMLElement>("[data-node='bridge']");
    const codexNode = document.querySelector<HTMLElement>("[data-node='codex']");
    if (bridgeNode !== null) bridgeNode.dataset.state = state.phase === "authenticated" ? "ready" : state.phase === "error" ? "error" : state.phase === "offline" ? "offline" : "working";
    if (codexNode !== null) codexNode.dataset.state = state.authenticated ? "ready" : "offline";
    this.#setText("transport-state", state.transport === undefined ? "Offline" : state.transport === "websocket" ? "WebSocket" : "HTTP poll");
    this.#setText("heartbeat-state", state.lastHeartbeat === undefined ? "—" : shortTime(state.lastHeartbeat));
    this.#element<HTMLButtonElement>("connect-button").disabled = state.authenticated;
    this.#setText("connect-button", state.phase === "connecting" || state.phase === "authenticating" ? "Retry" : "Connect");
    this.#element<HTMLButtonElement>("disconnect-button").disabled = state.phase === "offline";
    if (state.lastError !== undefined) this.#showError(state.lastError);
    else this.#clearError();
    const labels: Record<BridgeClientState["phase"], string> = {
      offline: "Bridge offline.",
      connecting: "Opening the local bridge.",
      authenticating: "Authenticating the local bridge.",
      authenticated: "Codex and InDesign are authenticated.",
      error: "The local bridge reported an error.",
    };
    this.#setEvent(labels[state.phase]);
  }

  #renderAuthentication(paired: boolean): void {
    this.#setText("authentication-state", paired ? "Paired" : "Unpaired");
    this.#setText("authentication-hint", paired ? "Token protected by UXP secure storage." : "Pair the token created by setup:token.");
  }

  #renderWorkspace(status: { authorized: boolean; name?: string; stale: boolean }): void {
    this.#setText("workspace-state", status.authorized ? "Authorized" : "Authorization required");
    this.#setText("workspace-hint", status.authorized
      ? `${status.name ?? "Workspace"} is the only allowed folder.`
      : status.stale ? "The saved authorization expired. Select the folder again." : "Select the only folder MCP may access.");
  }

  #showDocument(name: string | undefined, revision: number | undefined): void {
    this.#setText("document-name", name ?? "No document open");
    this.#setText("document-revision", revision === undefined ? "—" : String(revision));
  }

  #showError(message: string): void {
    const element = this.#element<HTMLElement>("last-error");
    element.textContent = message;
    element.hidden = false;
  }

  #clearError(): void {
    const element = this.#element<HTMLElement>("last-error");
    element.textContent = "";
    element.hidden = true;
  }

  #setEvent(message: string): void {
    this.#setText("last-event", message);
  }

  #setText(id: string, value: string): void {
    const element = document.getElementById(id);
    if (element !== null) element.textContent = value;
  }

  #element<T extends HTMLElement>(id: string, _prototype?: { prototype: T }): T {
    void _prototype;
    const element = document.getElementById(id);
    if (element === null) throw new Error(`Panel element '${id}' is missing.`);
    return element as T;
  }
}

const panel = new PanelController();
entrypoints.setup({
  panels: {
    "sol-indesign-mcp-bridge": {
      show: () => panel.show(),
      destroy: () => panel.destroy(),
    },
  },
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { void panel.initialize(); }, { once: true });
} else {
  void panel.initialize();
}

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function createLocalId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
