import { SafeBridgeError } from "../core/errors";
import { getMember } from "../core/records";
import { activeDocumentIfPresent, sameNativeDocument } from "./active-document";
import { createUndoLabel } from "./execution-context";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface UndoVerification {
  readonly targetDocumentActive: boolean;
  readonly applicationUndoMatches: boolean;
  readonly documentUndoMatches: boolean;
  readonly applicationRedoMatches: boolean;
  readonly documentRedoMatches: boolean;
}

/**
 * InDesign exposes both application-wide and document-specific Undo names.
 * The explicit active document is authoritative for a document mutation: the
 * application-wide name can legitimately describe a different global stack
 * entry in InDesign 21.4.1 even while Document.undoName is exact.
 */
export function isExactDocumentUndo(observation: UndoVerification): boolean {
  return observation.targetDocumentActive && observation.documentUndoMatches;
}

export function isExactDocumentRedo(observation: UndoVerification): boolean {
  return observation.targetDocumentActive && observation.documentRedoMatches;
}

export function resolutionErrorProvesObjectMissing(error: unknown): boolean {
  return error instanceof SafeBridgeError && error.code === "ITEM_NOT_FOUND";
}

export function verifyUndoTrace(
  application: unknown,
  document: unknown,
  traceId: string,
): UndoVerification {
  if (!UUID_PATTERN.test(traceId)) {
    throw new SafeBridgeError("INVALID_INPUT", "expectedUndoTraceId must be a UUID.");
  }
  const expected = createUndoLabel({ requestId: traceId, traceId });
  return {
    targetDocumentActive: targetDocumentIsActive(application, document),
    applicationUndoMatches: diagnosticUndoNameMatches(application, "undoName", expected),
    documentUndoMatches: requiredUndoName(document, "undoName", "Document") === expected,
    applicationRedoMatches: diagnosticUndoNameMatches(application, "redoName", expected),
    documentRedoMatches: requiredUndoName(document, "redoName", "Document") === expected,
  };
}

function diagnosticUndoNameMatches(
  target: unknown,
  key: "undoName" | "redoName",
  expected: string,
): boolean {
  try {
    return getMember(target, key) === expected;
  } catch {
    return false;
  }
}

function targetDocumentIsActive(application: unknown, document: unknown): boolean {
  try {
    return sameNativeDocument(activeDocumentIfPresent(application), document);
  } catch {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "InDesign did not expose the active document for Undo verification.",
    );
  }
}

function requiredUndoName(target: unknown, key: "undoName" | "redoName", owner: string): string {
  let value: unknown;
  try {
    value = getMember(target, key);
  } catch {
    value = undefined;
  }
  if (typeof value !== "string") {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      `This InDesign runtime does not expose the documented ${owner}.${key} value.`,
    );
  }
  return value;
}
