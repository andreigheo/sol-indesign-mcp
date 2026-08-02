import { describe, expect, it } from "vitest";
import { DocumentSessionState } from "./document-session-state";

describe("document session identity and revisions", () => {
  it("keeps one session UUID and revision across different proxy wrappers with the same native ID", () => {
    const state = new DocumentSessionState();
    const generatedUuid = "11111111-1111-4111-8111-111111111111";

    const firstObservation = state.resolveDocumentUuid(42, undefined, () => generatedUuid);
    expect(state.observeRevision(42, firstObservation)).toBe(1);
    expect(state.incrementRevision(42, firstObservation)).toBe(2);

    const secondObservation = state.resolveDocumentUuid(42, undefined, () => "22222222-2222-4222-8222-222222222222");
    expect(secondObservation).toBe(generatedUuid);
    expect(state.observeRevision(42, secondObservation)).toBe(2);
  });

  it("keeps two open document instances with the same persistent UUID independent", () => {
    const state = new DocumentSessionState();
    const persistentUuid = "33333333-3333-4333-8333-333333333333";

    expect(state.resolveDocumentUuid(7, persistentUuid, () => "unused")).toBe(persistentUuid);
    expect(state.resolveDocumentUuid(8, persistentUuid, () => "unused")).toBe(persistentUuid);
    expect(state.observeRevision(7, persistentUuid)).toBe(1);
    expect(state.incrementRevision(7, persistentUuid)).toBe(2);
    expect(state.observeRevision(8, persistentUuid)).toBe(1);
  });

  it("does not transfer a revision when a native ID is later bound to another persistent document UUID", () => {
    const state = new DocumentSessionState();
    const firstUuid = "44444444-4444-4444-8444-444444444444";
    const secondUuid = "55555555-5555-4555-8555-555555555555";

    state.resolveDocumentUuid(9, firstUuid, () => "unused");
    state.observeRevision(9, firstUuid);
    state.incrementRevision(9, firstUuid);
    expect(state.resolveDocumentUuid(9, secondUuid, () => "unused")).toBe(secondUuid);
    expect(state.observeRevision(9, secondUuid)).toBe(1);
  });

  it("seeds a fresh document instance from a persisted revision without overriding live state", () => {
    const state = new DocumentSessionState();
    const persistentUuid = "66666666-6666-4666-8666-666666666666";

    expect(state.observeRevision(10, persistentUuid, 7)).toBe(7);
    expect(state.observeRevision(10, persistentUuid, 9)).toBe(7);
  });
});
