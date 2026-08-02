import { describe, expect, it } from "vitest";
import { addVisibleDocument } from "./document-creation";

describe("visible document creation", () => {
  it("passes showingWindow=true without an arbitrary properties bag", () => {
    const created = { visible: true };
    const calls: unknown[][] = [];
    const documents = {
      add: (...args: unknown[]): unknown => {
        calls.push(args);
        return created;
      },
    };

    expect(addVisibleDocument(documents)).toBe(created);
    expect(calls).toEqual([[true]]);
  });
});
