import { describe, expect, it } from "vitest";
import { SafeBridgeError, toSafeError } from "./errors";

describe("safe UXP errors", () => {
  it("preserves intentionally user-safe structured errors", () => {
    const error = new SafeBridgeError("FILE_EXISTS", "The workspace file already exists.");
    expect(toSafeError(error)).toBe(error);
  });

  it("does not expose unknown host error messages", () => {
    const error = toSafeError(new Error("C:\\Users\\Andrei\\secret.indd token=top-secret"));
    expect(error.message).toBe("InDesign could not complete the requested operation.");
    expect(error.message).not.toContain("Andrei");
    expect(error.message).not.toContain("top-secret");
  });
});
