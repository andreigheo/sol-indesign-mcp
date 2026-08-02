import { describe, expect, it } from "vitest";
import { scanBoundedCollection } from "./bounded-collection";

describe("bounded preflight collection scan", () => {
  it("marks a scan incomplete instead of claiming a clean suffix", () => {
    expect(scanBoundedCollection([1, 2, 3], "items", 2)).toEqual({
      items: [1, 2],
      complete: false,
      total: 3,
    });
  });

  it("fails closed when the host collection is unavailable", () => {
    expect(() => scanBoundedCollection(undefined, "fonts"))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });
});
