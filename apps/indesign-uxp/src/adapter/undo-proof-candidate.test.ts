import { describe, expect, it } from "vitest";
import type { InDesignObjectRef, Operation } from "@sol/protocol";
import { isApprovedUndoProofBatch } from "./undo-proof-candidate";

describe("one-step Undo proof candidate", () => {
  it("accepts only the exact multi-operation creation, alias, text, and grouping batch", () => {
    expect(isApprovedUndoProofBatch(approvedOperations(), approvedAliases())).toBe(true);
  });

  it("rejects a weaker group-only batch", () => {
    expect(isApprovedUndoProofBatch([{
      type: "group_items",
      ref: "probeGroup",
      targets: [{ ref: "probeRectangle" }, { ref: "probeOval" }],
    }], approvedAliases())).toBe(false);
  });

  it("rejects a batch whose non-create mutation targets the wrong alias", () => {
    const operations = approvedOperations();
    operations[3] = { type: "set_text", target: { ref: "probeRectangle" }, text: "Proof" };
    expect(isApprovedUndoProofBatch(operations, approvedAliases())).toBe(false);
  });

  it("rejects incomplete or incorrectly typed returned aliases", () => {
    const aliases = approvedAliases();
    aliases.probeGroup = objectRef(14, "rectangle");
    expect(isApprovedUndoProofBatch(approvedOperations(), aliases)).toBe(false);
  });
});

function approvedOperations(): Operation[] {
  return [
    {
      type: "create_rectangle",
      ref: "probeRectangle",
      page: { ref: "probePage" },
      bounds: { x: 10, y: 10, width: 30, height: 20, unit: "pt" },
    },
    {
      type: "create_oval",
      ref: "probeOval",
      page: { ref: "probePage" },
      bounds: { x: 50, y: 10, width: 30, height: 20, unit: "pt" },
    },
    {
      type: "create_text_frame",
      ref: "probeText",
      page: { ref: "probePage" },
      bounds: { x: 10, y: 40, width: 70, height: 20, unit: "pt" },
    },
    { type: "set_text", target: { ref: "probeText" }, text: "Proof" },
    {
      type: "group_items",
      ref: "probeGroup",
      targets: [{ ref: "probeRectangle" }, { ref: "probeOval" }],
    },
  ];
}

function approvedAliases(): Record<string, InDesignObjectRef> {
  return {
    probeRectangle: objectRef(11, "rectangle"),
    probeOval: objectRef(12, "oval"),
    probeText: objectRef(13, "text_frame"),
    probeGroup: objectRef(14, "group"),
  };
}

function objectRef(nativeId: number, kind: InDesignObjectRef["kind"]): InDesignObjectRef {
  return {
    documentUuid: "47f0d872-7c3a-4f56-9ab6-39d78d142b61",
    nativeId,
    kind,
  };
}
