import { describe, expect, it } from "vitest";
import {
  assertClearOverridesCapability,
  enableObjectStyleAppearanceCategories,
  resolveJustification,
  setDocumentedOpacity,
} from "./style-safety";

describe("style safety mappings", () => {
  it("maps public justification values explicitly", () => {
    const values = {
      LEFT_ALIGN: 1,
      CENTER_ALIGN: 2,
      RIGHT_ALIGN: 3,
      LEFT_JUSTIFIED: 4,
    };
    expect(resolveJustification("left", values)).toBe(1);
    expect(resolveJustification("center", values)).toBe(2);
    expect(resolveJustification("right", values)).toBe(3);
    expect(resolveJustification("justify", values)).toBe(4);
  });

  it("enables object-style fill, stroke, and object transparency categories", () => {
    const style = { objectEffectsEnablingSettings: { enableTransparency: false } };
    enableObjectStyleAppearanceCategories(style, {
      fillColor: { name: "Fill" },
      strokeWeightPt: 2,
      opacity: 70,
    });
    expect(style).toEqual({
      enableFill: true,
      enableStroke: true,
      objectEffectsEnablingSettings: { enableTransparency: true },
    });
  });

  it("writes opacity only through documented nested blending settings", () => {
    const target = { transparencySettings: { blendingSettings: { opacity: 100 } } };
    setDocumentedOpacity(target, 42);
    expect(target.transparencySettings.blendingSettings.opacity).toBe(42);
    expect(() => setDocumentedOpacity({}, 42)).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
    }));
  });

  it("requires documented methods when clearOverrides is requested", () => {
    expect(() => assertClearOverridesCapability({}, "applyObjectStyle", true))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => assertClearOverridesCapability({}, "applyParagraphStyle", false)).not.toThrow();
    expect(() => assertClearOverridesCapability({ applyParagraphStyle: () => undefined }, "applyParagraphStyle", true))
      .not.toThrow();
  });
});
