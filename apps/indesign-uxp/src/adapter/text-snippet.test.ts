import { describe, expect, it, vi } from "vitest";
import { readBoundedTextSnippet } from "./text-snippet";

describe("bounded text snippets", () => {
  it("reads only the bounded character range and never top-level contents", () => {
    const itemByRange = vi.fn(() => ({ contents: "x".repeat(600) }));
    const item = Object.defineProperty({
      characters: { length: 10_000, itemByRange },
    }, "contents", {
      get: () => { throw new Error("full contents must not be read"); },
    });
    expect(readBoundedTextSnippet(item, "story")).toHaveLength(500);
    expect(itemByRange).toHaveBeenCalledWith(0, 499);
  });

  it("fails closed for text objects without bounded character ranges", () => {
    expect(() => readBoundedTextSnippet({}, "text_frame"))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(readBoundedTextSnippet({}, "rectangle")).toBe("");
  });

  it("joins the bounded character array returned by InDesign UXP", () => {
    const item = {
      characters: {
        length: 4,
        itemByRange: () => ({ contents: ["S", "o", "l", "!"] }),
      },
    };

    expect(readBoundedTextSnippet(item, "text_frame")).toBe("Sol!");
  });

  it("resolves bounded range elements when aggregate contents is opaque", () => {
    const item = {
      characters: {
        length: 3,
        itemByRange: () => ({
          contents: {},
          getElements: () => [{ contents: "M" }, { contents: "C" }, { contents: "P" }],
        }),
      },
    };

    expect(readBoundedTextSnippet(item, "text_frame")).toBe("MCP");
  });
});
