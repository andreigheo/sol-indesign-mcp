import { describe, expect, it } from "vitest";
import { readNonEmptyFileSize } from "./file-metadata";

describe("export file metadata", () => {
  it("returns a bounded metadata size without reading file contents", async () => {
    await expect(readNonEmptyFileSize({
      getMetadata: () => Promise.resolve({ isFile: true, size: 25_000_000 }),
    })).resolves.toBe(25_000_000);
  });

  it("rejects empty or invalid outputs", async () => {
    await expect(readNonEmptyFileSize({
      getMetadata: () => Promise.resolve({ isFile: true, size: 0 }),
    })).rejects.toMatchObject({ code: "UXP_OPERATION_FAILED" });
  });
});
