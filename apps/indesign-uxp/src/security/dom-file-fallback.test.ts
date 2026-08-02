import { describe, expect, it, vi } from "vitest";
import {
  executeAsyncWithStrictFileEntryFallback,
  executeWithStrictFileEntryFallback,
  isFileEntryInteropRejection,
} from "./dom-file-fallback";

describe("strict UXP File fallback", () => {
  it("retries only a classified File-entry interoperability rejection", () => {
    const entry = { name: "asset.png" };
    const operation = vi.fn((file: typeof entry | string) => {
      if (typeof file !== "string") throw new TypeError("Unsupported UXP File object argument");
      return file;
    });
    expect(executeWithStrictFileEntryFallback(entry, () => "C:/workspace/asset.png", operation))
      .toBe("C:/workspace/asset.png");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry an ordinary DOM failure", () => {
    const operation = vi.fn(() => { throw new Error("The placed asset is corrupt"); });
    expect(() => executeWithStrictFileEntryFallback({}, () => "native", operation)).toThrow("corrupt");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(isFileEntryInteropRejection(new Error("The placed asset is corrupt"))).toBe(false);
  });

  it("awaits asynchronous DOM work before reporting success", async () => {
    const entry = { name: "preview.png" };
    let completed = false;
    const operation = vi.fn(async () => {
      await Promise.resolve();
      completed = true;
      return "done";
    });

    await expect(executeAsyncWithStrictFileEntryFallback(entry, () => "native", operation)).resolves.toBe("done");
    expect(completed).toBe(true);
    expect(operation).toHaveBeenCalledWith(entry);
  });

  it("uses the contained native path after an asynchronous File-entry type rejection", async () => {
    const entry = { name: "preview.png" };
    const operation = vi.fn((file: typeof entry | string) => {
      if (typeof file !== "string") return Promise.reject(new Error("UXP file entry is not a valid file argument"));
      return Promise.resolve(file);
    });

    await expect(executeAsyncWithStrictFileEntryFallback(entry, () => "C:/workspace/preview.png", operation))
      .resolves.toBe("C:/workspace/preview.png");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated asynchronous failures", async () => {
    const operation = vi.fn(() => Promise.reject(new Error("export preset is corrupt")));

    await expect(executeAsyncWithStrictFileEntryFallback({}, () => "native", operation)).rejects.toThrow("corrupt");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
