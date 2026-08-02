import { describe, expect, it, vi } from "vitest";

vi.mock("indesign", () => ({
  AnchorPoint: {},
  BoundingBoxLimits: {},
  ColorModel: {},
  ColorSpace: {},
  CoordinateSpaces: {},
  ExportFormat: {},
  ExportRangeOrAllPages: {},
  FontStatus: {},
  Justification: {},
  LinkStatus: {},
  LocationOptions: {},
  PageRange: {},
  PNGExportRangeEnum: {},
  ScriptLanguage: {},
  UndoModes: {},
}));

vi.mock("uxp", () => ({
  storage: {
    formats: { binary: Symbol("binary") },
    localFileSystem: {},
  },
}));

import { DiagnosticRing } from "../diagnostics/diagnostic-ring";
import { WorkspaceManager } from "../security/workspace";
import { SolInDesignAdapter } from "./indesign-adapter";
import { InMemoryDocumentRevisionStore } from "./revision-store";

const DOCUMENT_UUID = "8ce9c7ca-de13-4835-bd62-224446cdef82";

describe("InDesign preflight process cleanup", () => {
  it("awaits cleanup exactly once after a valid aggregate result", async () => {
    const gate = cleanupGate();
    const host = createHost({
      aggregatedResults: ["Untitled-1", "[Basic]", []],
      remove: gate.remove,
    });
    const execution = host.adapter.execute("document.preflight", preflightInput());

    await proveCleanupAwaited(execution, gate);
    const result = await execution;

    expect(result).toMatchObject({ passed: true, errorCount: 0, profileName: "[Basic]" });
    expect(host.waitForProcess).toHaveBeenCalledExactlyOnceWith(100);
  });

  it("awaits cleanup exactly once when aggregate parsing fails closed", async () => {
    const gate = cleanupGate();
    const host = createHost({ aggregatedResults: [], remove: gate.remove });
    const execution = host.adapter.execute("document.preflight", preflightInput());

    await proveCleanupAwaited(execution, gate);
    await expect(execution).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
  });

  it("awaits cleanup exactly once when the bounded host wait throws", async () => {
    const hostFailure = new Error("host wait failed");
    const gate = cleanupGate();
    const host = createHost({
      aggregatedResults: ["Untitled-1", "[Basic]", []],
      remove: gate.remove,
      waitForProcess: vi.fn(() => {
        throw hostFailure;
      }),
    });
    const execution = host.adapter.execute("document.preflight", preflightInput());

    await proveCleanupAwaited(execution, gate);
    await expect(execution).rejects.toBe(hostFailure);
  });
});

interface CleanupGate {
  readonly remove: ReturnType<typeof vi.fn>;
  readonly started: Promise<void>;
  release(): void;
}

function cleanupGate(): CleanupGate {
  const started = signal();
  const allowed = signal();
  return {
    remove: vi.fn(() => {
      started.release();
      return allowed.promise;
    }),
    started: started.promise,
    release: allowed.release,
  };
}

async function proveCleanupAwaited(execution: Promise<unknown>, gate: CleanupGate): Promise<void> {
  let settled = false;
  const observed = execution.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await gate.started;
  await Promise.resolve();
  expect(gate.remove).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  gate.release();
  await observed;
  expect(gate.remove).toHaveBeenCalledTimes(1);
}

function signal(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createHost(options: {
  aggregatedResults: unknown;
  remove: ReturnType<typeof vi.fn>;
  waitForProcess?: ReturnType<typeof vi.fn>;
}): {
  adapter: SolInDesignAdapter;
  remove: ReturnType<typeof vi.fn>;
  waitForProcess: ReturnType<typeof vi.fn>;
} {
  const document = {
    id: 1,
    name: "Untitled-1",
    isValid: true,
    extractLabel: (key: string) => key.endsWith("document-uuid") ? DOCUMENT_UUID : "",
    fonts: [],
    links: [],
    textFrames: [],
  };
  const waitForProcess = options.waitForProcess ?? vi.fn(() => false);
  const process = {
    isValid: true,
    aggregatedResults: options.aggregatedResults,
    waitForProcess,
    remove: options.remove,
  };
  const application = {
    documents: [document],
    preflightProfiles: {
      itemByName: () => ({ isValid: true, name: "[Basic]" }),
    },
    preflightProcesses: {
      add: () => process,
    },
  };
  return {
    adapter: new SolInDesignAdapter(
      application,
      new WorkspaceManager(),
      new DiagnosticRing(),
      undefined,
      new InMemoryDocumentRevisionStore(),
    ),
    remove: options.remove,
    waitForProcess,
  };
}

function preflightInput(): Record<string, unknown> {
  return {
    documentRef: {
      documentUuid: DOCUMENT_UUID,
      nativeId: 1,
      name: "Untitled-1",
      revision: 1,
      identityPersistent: true,
    },
    profileName: "[Basic]",
    maxFindings: 500,
  };
}
