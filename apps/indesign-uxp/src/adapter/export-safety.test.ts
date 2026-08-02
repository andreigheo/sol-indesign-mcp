import { describe, expect, it } from "vitest";
import { assertSingleFilePdfPreset, assertSinglePageImageExport } from "./export-safety";

describe("bounded export modes", () => {
  it("allows only a single explicit page for PNG and JPEG", () => {
    expect(() => assertSinglePageImageExport("png", 1)).not.toThrow();
    expect(() => assertSinglePageImageExport("jpeg", 0)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => assertSinglePageImageExport("png", 2)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });

  it("rejects separate-page and unverifiable PDF preset modes", () => {
    expect(() => assertSingleFilePdfPreset(false)).not.toThrow();
    expect(() => assertSingleFilePdfPreset(true)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => assertSingleFilePdfPreset(undefined)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });
});
