import { describe, expect, it } from "vitest";
import { assertMutableResourceName, assertMutableResourceObject } from "./resource-safety";

describe("protected InDesign resources", () => {
  it("rejects localized bracketed built-in names", () => {
    expect(() => assertMutableResourceName("[Papier]")).toThrow("built-in resource");
    expect(() => assertMutableResourceObject({ name: "[Paragraphe standard]" }, "Body"))
      .toThrow("built-in resource");
  });

  it("accepts an ordinary user resource", () => {
    expect(() => assertMutableResourceObject({ name: "Brand Blue" }, "Brand Blue")).not.toThrow();
  });
});
