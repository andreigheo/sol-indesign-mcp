import { describe, expect, it, vi } from "vitest";
import { readBinaryFile } from "./binary-file";

describe("UXP binary file reads", () => {
  it("passes the documented storage format Symbol and preserves bytes", async () => {
    const binaryFormat = Symbol("binary");
    const bytes = Uint8Array.from([0, 255, 128, 1]);
    const read = vi.fn(() => Promise.resolve(bytes.buffer));
    const file = { read };

    await expect(readBinaryFile(file, binaryFormat)).resolves.toEqual(bytes);
    expect(read).toHaveBeenCalledWith({ format: binaryFormat });
  });

  it("fails closed when the runtime returns text for a binary read", async () => {
    const file = { read: vi.fn(() => Promise.resolve("not binary")) };

    await expect(readBinaryFile(file, Symbol("binary"))).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
  });
});
