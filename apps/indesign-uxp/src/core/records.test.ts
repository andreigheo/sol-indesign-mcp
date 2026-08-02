import { describe, expect, it, vi } from "vitest";
import { collectionItems, collectionLength } from "./records";

describe("bounded host collection access", () => {
  it("uses bounded indexed item access without materializing every element", () => {
    const everyItem = vi.fn(() => { throw new Error("must not materialize the collection"); });
    const collection = {
      length: 3,
      item: (index: number) => ({ id: index, isValid: true }),
      everyItem,
    };
    expect(collectionItems(collection, 2)).toEqual([{ id: 0, isValid: true }, { id: 1, isValid: true }]);
    expect(everyItem).not.toHaveBeenCalled();
    expect(collectionLength(collection)).toBe(3);
  });

  it("reports unknown length instead of treating an unavailable collection as empty", () => {
    expect(collectionLength(undefined)).toBeUndefined();
  });
});
