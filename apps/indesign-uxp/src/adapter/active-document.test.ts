import { describe, expect, it } from "vitest";
import { activeDocumentIfPresent, sameNativeDocument } from "./active-document";

describe("active InDesign document resolution", () => {
  it("does not read the throwing activeDocument property when the collection is empty", () => {
    let activeDocumentReads = 0;
    const application = {
      documents: { length: 0 },
      get activeDocument(): unknown {
        activeDocumentReads += 1;
        throw new Error("No documents are open.");
      },
    };

    expect(activeDocumentIfPresent(application)).toBeUndefined();
    expect(activeDocumentReads).toBe(0);
  });

  it("returns the valid active document when documents are open", () => {
    const document = { isValid: true };
    const application = { documents: { length: 1 }, activeDocument: document };

    expect(activeDocumentIfPresent(application)).toBe(document);
  });

  it("rejects an invalid active document", () => {
    const application = { documents: { length: 1 }, activeDocument: { isValid: false } };

    expect(activeDocumentIfPresent(application)).toBeUndefined();
  });

  it("matches fresh proxy wrappers by stable native document ID", () => {
    expect(sameNativeDocument({ id: 17 }, { id: 17 })).toBe(true);
    expect(sameNativeDocument({ id: 17 }, { id: 18 })).toBe(false);
    expect(sameNativeDocument({ name: "Untitled" }, { name: "Untitled" })).toBe(false);
  });
});
