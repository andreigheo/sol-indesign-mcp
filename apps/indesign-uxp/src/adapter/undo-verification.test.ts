import { describe, expect, it } from "vitest";
import { SafeBridgeError } from "../core/errors";
import {
  isExactDocumentRedo,
  isExactDocumentUndo,
  resolutionErrorProvesObjectMissing,
  verifyUndoTrace,
} from "./undo-verification";

const TRACE_ID = "fe1de7b5-1efe-40df-9f0f-5a48d1fd7b64";
const LABEL = `Sol InDesign MCP · ${TRACE_ID}`;

describe("read-only Undo verification", () => {
  it("compares only the derived trace label on the application and explicit document", () => {
    const document = { id: 11, undoName: LABEL, redoName: "" };
    const application = {
      documents: { length: 1 },
      activeDocument: document,
      undoName: LABEL,
      redoName: "",
    };

    expect(verifyUndoTrace(application, document, TRACE_ID)).toEqual({
      targetDocumentActive: true,
      applicationUndoMatches: true,
      documentUndoMatches: true,
      applicationRedoMatches: false,
      documentRedoMatches: false,
    });
  });

  it("detects the exact action at the top of both Redo stacks after one Undo", () => {
    const document = { id: 11, undoName: "Earlier action", redoName: LABEL };
    const application = {
      documents: { length: 1 },
      activeDocument: document,
      undoName: "Earlier action",
      redoName: LABEL,
    };

    expect(verifyUndoTrace(application, document, TRACE_ID)).toMatchObject({
      targetDocumentActive: true,
      applicationUndoMatches: false,
      documentUndoMatches: false,
      applicationRedoMatches: true,
      documentRedoMatches: true,
    });
  });

  it("treats the explicit active document as authoritative when the application-wide stack differs", () => {
    const document = { id: 11, undoName: LABEL, redoName: "" };
    const application = {
      documents: { length: 1 },
      activeDocument: document,
      undoName: "Different global action",
      redoName: "",
    };
    const beforeUndo = verifyUndoTrace(application, document, TRACE_ID);

    expect(beforeUndo.applicationUndoMatches).toBe(false);
    expect(beforeUndo.documentUndoMatches).toBe(true);
    expect(isExactDocumentUndo(beforeUndo)).toBe(true);

    document.undoName = "Earlier document action";
    document.redoName = LABEL;
    application.undoName = "Different global action";
    application.redoName = "Different global redo";
    const afterUndo = verifyUndoTrace(application, document, TRACE_ID);

    expect(afterUndo.applicationRedoMatches).toBe(false);
    expect(afterUndo.documentRedoMatches).toBe(true);
    expect(isExactDocumentRedo(afterUndo)).toBe(true);
  });

  it("rejects an application-only match when the explicit document does not match", () => {
    const document = { id: 11, undoName: "Different document action", redoName: "Different document redo" };
    const application = {
      documents: { length: 1 },
      activeDocument: document,
      undoName: LABEL,
      redoName: LABEL,
    };
    const observation = verifyUndoTrace(application, document, TRACE_ID);

    expect(observation.applicationUndoMatches).toBe(true);
    expect(observation.documentUndoMatches).toBe(false);
    expect(isExactDocumentUndo(observation)).toBe(false);
    expect(observation.applicationRedoMatches).toBe(true);
    expect(observation.documentRedoMatches).toBe(false);
    expect(isExactDocumentRedo(observation)).toBe(false);
  });

  it("keeps unavailable application-wide names diagnostic when document names are usable", () => {
    const document = { id: 11, undoName: LABEL, redoName: LABEL };
    const application = {
      documents: { length: 1 },
      activeDocument: document,
      get undoName(): string { throw new Error("unsupported global Undo name"); },
      get redoName(): string { throw new Error("unsupported global Redo name"); },
    };
    const observation = verifyUndoTrace(application, document, TRACE_ID);

    expect(observation.applicationUndoMatches).toBe(false);
    expect(observation.applicationRedoMatches).toBe(false);
    expect(isExactDocumentUndo(observation)).toBe(true);
    expect(isExactDocumentRedo(observation)).toBe(true);
  });

  it("does not accept a different active document", () => {
    const document = { id: 11, undoName: LABEL, redoName: "" };
    const application = {
      documents: { length: 2 },
      activeDocument: { id: 12 },
      undoName: LABEL,
      redoName: "",
    };

    const observation = verifyUndoTrace(application, document, TRACE_ID);
    expect(observation.targetDocumentActive).toBe(false);
    expect(isExactDocumentUndo(observation)).toBe(false);
  });

  it("fails closed for invalid trace IDs or absent document-scoped members", () => {
    expect(() => verifyUndoTrace({}, {}, "not-a-uuid")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => verifyUndoTrace(
      { documents: { length: 1 }, activeDocument: { id: 11 }, undoName: LABEL, redoName: "" },
      { id: 11, redoName: "" },
      TRACE_ID,
    )).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });

  it("accepts only ITEM_NOT_FOUND as proof that a created alias disappeared", () => {
    expect(resolutionErrorProvesObjectMissing(new SafeBridgeError("ITEM_NOT_FOUND", "gone"))).toBe(true);
    expect(resolutionErrorProvesObjectMissing(new SafeBridgeError("STALE_OBJECT", "changed"))).toBe(false);
    expect(resolutionErrorProvesObjectMissing(new Error("runtime failure"))).toBe(false);
  });
});
