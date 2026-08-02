import { describe, expect, it } from "vitest";
import { PAGE_KIND, TEXT_KIND, assertSemanticTargetKind } from "./semantic-target";

describe("operation target semantics", () => {
  it("accepts an allowed kind", () => {
    expect(() => assertSemanticTargetKind("story", TEXT_KIND, "set_text.target")).not.toThrow();
  });

  it("rejects a stable reference of the wrong semantic kind", () => {
    expect(() => assertSemanticTargetKind("layer", PAGE_KIND, "create_rectangle.page"))
      .toThrow(/requires a page target/u);
  });
});
