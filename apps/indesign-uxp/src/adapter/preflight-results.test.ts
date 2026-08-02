import { describe, expect, it } from "vitest";
import { parsePreflightResults, waitForPreflightCompletion } from "./preflight-results";

describe("InDesign preflight result parsing", () => {
  it("parses the documented nested aggregate result shape", () => {
    const parsed = parsePreflightResults([
      "Document.indd",
      "[Basic]",
      [
        [42, "Missing Font", 3, "A font is not available", [["Font", "Minion Pro"]]],
        [43, "RGB Color", 5, "An RGB swatch is used", []],
        [44, "Missing Link", 6, "A link is unavailable", []],
      ],
    ], 500);

    expect(parsed.total).toBe(3);
    expect(parsed.byCategory["Missing Font"]?.[0]).toEqual({
      category: "Missing Font",
      message: "A font is not available",
      details: ["Font: Minion Pro"],
    });
    expect(parsed.colorFindings).toHaveLength(1);
    expect(parsed.byCategory["RGB Color"]).toBeUndefined();
  });

  it("reports truncation without flattening nested rows", () => {
    const parsed = parsePreflightResults(["Document.indd", "[Basic]", [
      [1, "One", 1, "First", []],
      [2, "Two", 2, "Second", []],
    ]], 1);
    expect(parsed).toMatchObject({ total: 2, totalReturned: 1, truncated: true });
  });

  it("fails closed for undocumented result shapes", () => {
    expect(() => parsePreflightResults([["flat", "row"]], 10)).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
    }));
  });

  it.each([true, false, undefined])("uses the documented bounded wait without interpreting %s", async (signal) => {
    const waitTimes: number[] = [];

    await waitForPreflightCompletion((waitTimeSeconds) => {
      waitTimes.push(waitTimeSeconds);
      return signal;
    });

    expect(waitTimes).toEqual([100]);
  });

  it("propagates a host wait failure before result parsing", async () => {
    const failure = new Error("host wait failed");
    const completion = waitForPreflightCompletion(() => Promise.reject(failure));

    await expect(completion).rejects.toBe(failure);
  });
});
