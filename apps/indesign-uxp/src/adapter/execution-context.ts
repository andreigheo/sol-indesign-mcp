import { SafeBridgeError } from "../core/errors";
import { callMember } from "../core/records";

export interface AdapterExecutionContext {
  readonly requestId: string;
  readonly traceId: string;
}

/** Produces the exact, request-specific label returned with every real batch. */
export function createUndoLabel(context: AdapterExecutionContext): string {
  return `Sol InDesign MCP · ${context.traceId}`;
}

export interface UndoGroupingRuntime {
  readonly scriptLanguage: string | number;
  readonly undoMode: string | number;
  readonly usedDocumentedConstants: boolean;
}

// Adobe documents these numeric enum values for the InDesign DOM. Some UXP
// plugin runtimes expose the enum containers but not primitive member values.
export const DOCUMENTED_UXPSCRIPT = 1_431_522_407;
export const DOCUMENTED_ENTIRE_SCRIPT = 1_699_963_733;

export function resolveUndoGroupingRuntime(
  hasDoScript: boolean,
  scriptLanguage: unknown,
  undoMode: unknown,
): UndoGroupingRuntime | undefined {
  if (!hasDoScript) return undefined;
  const hasRuntimeScriptLanguage = isEnumValue(scriptLanguage);
  const hasRuntimeUndoMode = isEnumValue(undoMode);
  return {
    scriptLanguage: hasRuntimeScriptLanguage ? scriptLanguage : DOCUMENTED_UXPSCRIPT,
    undoMode: hasRuntimeUndoMode ? undoMode : DOCUMENTED_ENTIRE_SCRIPT,
    usedDocumentedConstants: !hasRuntimeScriptLanguage || !hasRuntimeUndoMode,
  };
}

export function requireUndoGroupingRuntime(
  hasDoScript: boolean,
  scriptLanguage: unknown,
  undoMode: unknown,
): UndoGroupingRuntime {
  const runtime = resolveUndoGroupingRuntime(hasDoScript, scriptLanguage, undoMode);
  if (runtime === undefined) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "This InDesign runtime cannot guarantee function-form UXPSCRIPT execution in one Undo group.",
    );
  }
  return runtime;
}

export async function executeFunctionFormUndoGroup(
  application: unknown,
  runtime: UndoGroupingRuntime,
  undoLabel: string,
  script: () => void,
): Promise<void> {
  // InDesign 21.4 can return an opaque Promise-like host result even though
  // the function executes successfully. Await completion, but never treat the
  // host return value as the operation summary; the closure-owned progress is
  // the authoritative bounded result.
  const callbackFailure: { caught: boolean; error: unknown } = { caught: false, error: undefined };
  const guardedScript = (): void => {
    try {
      script();
    } catch (error: unknown) {
      callbackFailure.caught = true;
      callbackFailure.error = error;
      throw error;
    }
  };
  try {
    await callMember(application, "doScript", [
      guardedScript,
      runtime.scriptLanguage,
      [],
      runtime.undoMode,
      undoLabel,
    ]);
  } catch (hostError: unknown) {
    // UXP can replace an exception thrown by the callback with an opaque host
    // exception. Preserve the callback's already-bounded SafeBridgeError so
    // partial-operation metadata survives the doScript boundary.
    if (callbackFailure.caught) throw callbackFailure.error;
    throw hostError;
  }
}

function isEnumValue(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0)
    || (typeof value === "number" && Number.isFinite(value));
}
