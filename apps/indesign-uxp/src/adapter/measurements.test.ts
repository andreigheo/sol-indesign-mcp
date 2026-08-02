import { describe, expect, it } from "vitest";
import { pointMeasurement } from "./measurements";

describe("DOM measurements", () => {
  it("qualifies values as points instead of relying on ruler preferences", () => {
    expect(pointMeasurement(72)).toBe("72 pt");
    expect(pointMeasurement(595.275590551)).toBe("595.275590551 pt");
  });

  it("rejects non-finite values", () => {
    expect(() => pointMeasurement(Number.NaN)).toThrow("must be finite");
  });
});
