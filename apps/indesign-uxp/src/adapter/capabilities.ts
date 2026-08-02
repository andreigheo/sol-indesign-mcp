import type { Capability } from "@sol/protocol";
import { getMember, hasMethod } from "../core/records";
import { resolveUndoGroupingRuntime } from "./execution-context";

export type CapabilityMap = Record<string, Capability>;

export interface CapabilityRuntimeMembers {
  readonly scriptLanguage?: unknown;
  readonly undoMode?: unknown;
  readonly groupingArraysProbed?: boolean;
  readonly undoGroupingProbed?: boolean;
}

export function detectCapabilities(application: unknown, runtime: CapabilityRuntimeMembers = {}): CapabilityMap {
  const documents = getMember(application, "documents");
  const undoGrouping = detectUndoGroupingCapability(application, runtime);
  return {
    doScriptUndoGrouping: undoGrouping,
    documentEnumeration: documentedWhenPresent(
      documents !== undefined,
      "Application.documents is unavailable.",
      "Application.documents is present; enumeration is verified only when a queued request succeeds.",
    ),
    secureStorage: { status: "documented" },
    persistentWorkspaceTokens: { status: "documented" },
    websocketLoopback: documentedWhenPresent(
      typeof WebSocket === "function",
      "WebSocket is unavailable in this UXP runtime.",
      "The WebSocket API is present; plain loopback acceptance remains pending a successful host session.",
    ),
    httpLongPolling: documentedWhenPresent(
      typeof fetch === "function",
      "fetch is unavailable in this UXP runtime.",
      "The fetch API is present; loopback long polling remains pending a successful host session.",
    ),
    fileEntryDomInterop: {
      status: "unavailable",
      reason: "Runtime behavior is probed per file operation; native-path fallback remains workspace-contained.",
    },
    groupingArrays: {
      status: runtime.groupingArraysProbed === true ? "runtimeProbed" : "documented",
      reason: runtime.groupingArraysProbed === true
        ? "The common container's Groups.add completed with an exact PageItems.itemByRange specifier and exact direct-membership verification in this host session."
        : "Adobe documents Spread.groups, Groups.add, and PageItems.itemByRange; the adapter resolves one common container and verifies the exact range and direct membership per operation.",
    },
    preflight: documentedWhenPresent(
      getMember(application, "preflightProcesses") !== undefined,
      "Preflight processes are unavailable.",
      "Preflight processes are present; result shape and cleanup remain pending a real-host probe.",
    ),
  };
}

function detectUndoGroupingCapability(
  application: unknown,
  runtime: CapabilityRuntimeMembers,
): Capability {
  const resolved = resolveUndoGroupingRuntime(
    hasMethod(application, "doScript"),
    runtime.scriptLanguage,
    runtime.undoMode,
  );
  if (resolved === undefined) {
    return {
      status: "unavailable",
      reason: "Required runtime member is unavailable: Application.doScript.",
    };
  }
  if (runtime.undoGroupingProbed === true) {
    return {
      status: "runtimeProbed",
      reason: "The exact batch label was observed on the explicit active document's Undo and Redo stacks, and all tracked created aliases disappeared after one user Undo in this host session.",
    };
  }
  return {
    status: "documented",
    reason: resolved.usedDocumentedConstants
      ? "Application.doScript is present. Runtime enum exports are unavailable, so the adapter will use Adobe-documented numeric UXPSCRIPT/ENTIRE_SCRIPT values; function-form behavior and one-step Undo remain pending a real-host probe."
      : "Function-form UXPSCRIPT and one-step Undo remain pending a real-host probe.",
  };
}

function documentedWhenPresent(present: boolean, unavailableReason: string, pendingReason: string): Capability {
  return present
    ? { status: "documented", reason: pendingReason }
    : { status: "unavailable", reason: unavailableReason };
}
