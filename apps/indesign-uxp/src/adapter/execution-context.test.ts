import { describe, expect, it } from "vitest";
import { SafeBridgeError } from "../core/errors";
import {
  createUndoLabel,
  DOCUMENTED_ENTIRE_SCRIPT,
  DOCUMENTED_UXPSCRIPT,
  executeFunctionFormUndoGroup,
  requireUndoGroupingRuntime,
  resolveUndoGroupingRuntime,
} from "./execution-context";

describe("operation execution context", () => {
  it("creates a stable request-specific undo label", () => {
    const label = createUndoLabel({
      requestId: "b468f4f8-d0bf-4ee1-8f0b-7fe426a04aa1",
      traceId: "fe1de7b5-1efe-40df-9f0f-5a48d1fd7b64",
    });
    expect(label).toBe("Sol InDesign MCP · fe1de7b5-1efe-40df-9f0f-5a48d1fd7b64");
  });

  it("uses valid runtime enum values, including zero", () => {
    expect(requireUndoGroupingRuntime(true, 0, 0)).toEqual({
      scriptLanguage: 0,
      undoMode: 0,
      usedDocumentedConstants: false,
    });
  });

  it("falls back to Adobe-documented enum numbers for invalid runtime exports", () => {
    expect(resolveUndoGroupingRuntime(true, undefined, {})).toEqual({
      scriptLanguage: DOCUMENTED_UXPSCRIPT,
      undoMode: DOCUMENTED_ENTIRE_SCRIPT,
      usedDocumentedConstants: true,
    });
    expect(resolveUndoGroupingRuntime(true, Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      scriptLanguage: DOCUMENTED_UXPSCRIPT,
      undoMode: DOCUMENTED_ENTIRE_SCRIPT,
      usedDocumentedConstants: true,
    });
  });

  it("fails closed when Application.doScript is absent", () => {
    expect(() => requireUndoGroupingRuntime(false, 1, 2)).toThrow("cannot guarantee");
  });

  it("awaits an opaque asynchronous host result and relies on closure progress", async () => {
    let completed = false;
    const application = {
      doScript: (script: () => void): Promise<{ readonly hostResult: true }> => Promise.resolve().then(() => {
        script();
        return { hostResult: true };
      }),
    };

    await executeFunctionFormUndoGroup(
      application,
      { scriptLanguage: DOCUMENTED_UXPSCRIPT, undoMode: DOCUMENTED_ENTIRE_SCRIPT, usedDocumentedConstants: true },
      "Sol test",
      () => { completed = true; },
    );

    expect(completed).toBe(true);
  });

  it("propagates an asynchronous host rejection after the function starts", async () => {
    let started = false;
    const application = {
      doScript: (script: () => void): Promise<never> => Promise.resolve().then(() => {
        script();
        throw new Error("host rejected Undo group");
      }),
    };

    await expect(executeFunctionFormUndoGroup(
      application,
      { scriptLanguage: DOCUMENTED_UXPSCRIPT, undoMode: DOCUMENTED_ENTIRE_SCRIPT, usedDocumentedConstants: true },
      "Sol test",
      () => { started = true; },
    )).rejects.toThrow("host rejected Undo group");
    expect(started).toBe(true);
  });

  it("preserves a bounded callback error when the host replaces it", async () => {
    const callbackError = new SafeBridgeError("UXP_OPERATION_FAILED", "bounded failure", {
      details: { failedStage: "group.add" },
    });
    const application = {
      doScript: (script: () => void): Promise<void> => {
        try {
          script();
        } catch {
          return Promise.reject(new Error("opaque host wrapper"));
        }
        return Promise.resolve();
      },
    };

    let caught: unknown;
    try {
      await executeFunctionFormUndoGroup(
        application,
        { scriptLanguage: DOCUMENTED_UXPSCRIPT, undoMode: DOCUMENTED_ENTIRE_SCRIPT, usedDocumentedConstants: true },
        "Sol test",
        () => { throw callbackError; },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBe(callbackError);
  });
});
