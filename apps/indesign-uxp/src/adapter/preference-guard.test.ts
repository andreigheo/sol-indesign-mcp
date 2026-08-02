import { describe, expect, it } from "vitest";
import { createPreferenceGuard } from "./preference-guard";

describe("export preference guard", () => {
  it("restores every readable touched preference", () => {
    const preferences = { pageString: "old", exportResolution: 72, viewPDF: true };
    const guard = createPreferenceGuard(preferences, ["pageString", "exportResolution", "viewPDF"]);
    preferences.pageString = "new";
    preferences.exportResolution = 300;
    preferences.viewPDF = false;
    guard.restore();
    expect(preferences).toEqual({ pageString: "old", exportResolution: 72, viewPDF: true });
  });

  it("fails closed before mutation when a required preference is unavailable", () => {
    expect(() => createPreferenceGuard({}, ["pageString"])).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
    }));
  });

  it("surfaces restoration failures", () => {
    let value = "old";
    let writes = 0;
    const preferences = Object.defineProperty({}, "pageString", {
      configurable: true,
      get: () => value,
      set: (next: unknown) => {
        writes += 1;
        if (writes > 1) throw new Error("host restore failure");
        value = String(next);
      },
    });
    const guard = createPreferenceGuard(preferences, ["pageString"]);
    Reflect.set(preferences, "pageString", "new");
    expect(() => guard.restore()).toThrow(expect.objectContaining({
      code: "UXP_OPERATION_FAILED",
      details: { preferenceKeys: ["pageString"] },
    }));
  });
});
