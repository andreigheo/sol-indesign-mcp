import { describe, expect, it } from "vitest";
import {
  InMemoryDocumentRevisionStore,
  LocalStorageDocumentRevisionStore,
} from "./revision-store";

const DOCUMENT_UUID = "11111111-1111-4111-8111-111111111111";

describe("persistent document revision store", () => {
  it("keeps duplicate document UUIDs independent by native document instance", () => {
    const store = new InMemoryDocumentRevisionStore();
    store.write(DOCUMENT_UUID, 7, 3);
    store.write(DOCUMENT_UUID, 8, 5);

    expect(store.read(DOCUMENT_UUID, 7)).toBe(3);
    expect(store.read(DOCUMENT_UUID, 8)).toBe(5);
  });

  it("round-trips canonical positive revisions through plugin storage", () => {
    const values = new Map<string, string>();
    const store = new LocalStorageDocumentRevisionStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    });

    expect(store.read(DOCUMENT_UUID, 9)).toBeUndefined();
    store.write(DOCUMENT_UUID, 9, 42);
    expect(store.read(DOCUMENT_UUID, 9)).toBe(42);
  });

  it("fails closed for malformed or unavailable persistent state", () => {
    const malformed = new LocalStorageDocumentRevisionStore({
      getItem: () => "01",
      setItem: () => undefined,
    });
    const unavailable = new LocalStorageDocumentRevisionStore({
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => undefined,
    });

    expect(() => malformed.read(DOCUMENT_UUID, 10)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => unavailable.read(DOCUMENT_UUID, 10)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });
});
