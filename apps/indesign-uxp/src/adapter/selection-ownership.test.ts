import { describe, expect, it } from "vitest";
import { belongsToDocument } from "./selection-ownership";

describe("selection ownership", () => {
  it("accepts only items whose parent chain reaches the requested document", () => {
    const document = {};
    const page = { parent: document };
    expect(belongsToDocument({ parent: page }, document)).toBe(true);
    expect(belongsToDocument({ parent: {} }, document)).toBe(false);
    expect(belongsToDocument({}, document)).toBe(false);
  });
});
