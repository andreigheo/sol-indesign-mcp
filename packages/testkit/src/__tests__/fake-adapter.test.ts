import { randomUUID } from "node:crypto";
import {
  BRIDGE_PROTOCOL,
  type BridgeMethod,
  type BridgeRequest,
} from "@sol/protocol";
import { describe, expect, it } from "vitest";
import { FakeInDesignAdapter } from "../fake-adapter.js";
import { fixtureDocumentRef, fixtureItemRef, fixturePageRef } from "../fixtures.js";

function request(method: BridgeMethod, params: Readonly<Record<string, unknown>>): BridgeRequest {
  return {
    protocol: BRIDGE_PROTOCOL,
    type: "request",
    id: randomUUID(),
    method,
    params: { ...params },
    meta: { traceId: randomUUID(), deadlineMs: 5_000 },
  };
}

describe("FakeInDesignAdapter", () => {
  it("returns protocol-schema-valid results for every production bridge method", async () => {
    const adapter = new FakeInDesignAdapter();
    const documentRef = fixtureDocumentRef();
    const pageRef = fixturePageRef();
    const cases: readonly (readonly [BridgeMethod, Readonly<Record<string, unknown>>])[] = [
      ["indesign.status", {}],
      ["document.list", {}],
      ["document.snapshot", { documentRef }],
      ["document.selection", { documentRef }],
      ["document.inspectItems", { documentRef, objectRefs: [fixtureItemRef()] }],
      ["document.create", {}],
      ["document.applyOperations", {
        documentRef,
        expectedRevision: 1,
        operations: [{ type: "ensure_layer", ref: "layer", name: "Contract Layer" }],
        dryRun: true,
      }],
      ["document.exportPreview", {
        documentRef,
        expectedRevision: 1,
        pageRef,
        targetPath: "previews/all-methods.png",
      }],
      ["document.saveCopy", {
        documentRef,
        expectedRevision: 1,
        targetPath: "copies/all-methods.indd",
      }],
      ["document.export", {
        documentRef,
        expectedRevision: 1,
        targetPath: "exports/all-methods.pdf",
        format: "pdf",
        pdfPresetName: "[High Quality Print]",
      }],
      ["document.preflight", { documentRef }],
    ];

    for (const [method, params] of cases) {
      await expect(adapter.dispatch(request(method, params))).resolves.toBeDefined();
    }
    expect(adapter.requests.map((item) => item.method)).toEqual(cases.map(([method]) => method));
  });

  it("returns a structured stale-document failure before a fake mutation", async () => {
    const adapter = new FakeInDesignAdapter();
    const operationRequest = request("document.applyOperations", {
      documentRef: fixtureDocumentRef(99),
      expectedRevision: 99,
      operations: [{ type: "ensure_layer", name: "Wrong Revision" }],
      dryRun: false,
    });

    await expect(adapter.dispatch(operationRequest)).rejects.toMatchObject({
      code: "STALE_DOCUMENT",
      retryable: true,
    });
    expect(adapter.revision).toBe(1);
  });
});
