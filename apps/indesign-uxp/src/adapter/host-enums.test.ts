import { describe, expect, it } from "vitest";
import {
  DOCUMENTED_BOTTOM_RIGHT_ANCHOR,
  DOCUMENTED_COLOR_MODEL_PROCESS,
  DOCUMENTED_COLOR_SPACE_CMYK,
  DOCUMENTED_COLOR_SPACE_RGB,
  DOCUMENTED_EXPORT_FORMAT_INDESIGN_MARKUP,
  DOCUMENTED_EXPORT_FORMAT_JPG,
  DOCUMENTED_EXPORT_FORMAT_PDF_TYPE,
  DOCUMENTED_EXPORT_FORMAT_PNG_FORMAT,
  DOCUMENTED_EXPORT_RANGE,
  DOCUMENTED_FONT_STATUS_NOT_AVAILABLE,
  DOCUMENTED_FONT_STATUS_SUBSTITUTED,
  DOCUMENTED_GEOMETRIC_PATH_BOUNDS,
  DOCUMENTED_LINK_STATUS_INACCESSIBLE,
  DOCUMENTED_LINK_STATUS_MISSING,
  DOCUMENTED_LINK_STATUS_OUT_OF_DATE,
  DOCUMENTED_PAGE_COORDINATES,
  DOCUMENTED_PAGE_RANGE_ALL_PAGES,
  DOCUMENTED_TOP_LEFT_ANCHOR,
  resolveDocumentedHostEnum,
} from "./host-enums";

describe("documented InDesign host enum fallback", () => {
  it("preserves primitive runtime values, including zero", () => {
    expect(resolveDocumentedHostEnum(0, DOCUMENTED_PAGE_COORDINATES)).toBe(0);
    expect(resolveDocumentedHostEnum("runtime", DOCUMENTED_PAGE_COORDINATES)).toBe("runtime");
  });

  it("uses only the exact Adobe-documented geometry constants for invalid runtime exports", () => {
    expect(resolveDocumentedHostEnum(undefined, DOCUMENTED_PAGE_COORDINATES)).toBe(2_021_224_551);
    expect(resolveDocumentedHostEnum({}, DOCUMENTED_TOP_LEFT_ANCHOR)).toBe(1_095_660_652);
    expect(resolveDocumentedHostEnum(Number.NaN, DOCUMENTED_BOTTOM_RIGHT_ANCHOR)).toBe(1_095_656_050);
    expect(resolveDocumentedHostEnum(null, DOCUMENTED_GEOMETRIC_PATH_BOUNDS)).toBe(1_768_844_080);
  });

  it("uses the exact Adobe-documented export and preflight constants for opaque runtime exports", () => {
    const opaqueRuntimeExport = {};
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_EXPORT_FORMAT_PDF_TYPE)).toBe(1_952_403_524);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_EXPORT_FORMAT_PNG_FORMAT)).toBe(1_699_761_735);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_EXPORT_FORMAT_JPG)).toBe(1_246_775_072);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_EXPORT_FORMAT_INDESIGN_MARKUP)).toBe(1_768_189_292);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_EXPORT_RANGE)).toBe(1_785_742_674);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_PAGE_RANGE_ALL_PAGES)).toBe(1_886_547_553);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_FONT_STATUS_NOT_AVAILABLE)).toBe(1_718_832_705);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_FONT_STATUS_SUBSTITUTED)).toBe(1_718_834_037);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_LINK_STATUS_MISSING)).toBe(1_819_109_747);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_LINK_STATUS_INACCESSIBLE)).toBe(1_818_848_865);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_LINK_STATUS_OUT_OF_DATE)).toBe(1_819_242_340);
  });

  it("uses the exact Adobe-documented color constants for opaque runtime exports", () => {
    const opaqueRuntimeExport = {};
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_COLOR_MODEL_PROCESS)).toBe(1_886_548_851);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_COLOR_SPACE_RGB)).toBe(1_666_336_578);
    expect(resolveDocumentedHostEnum(opaqueRuntimeExport, DOCUMENTED_COLOR_SPACE_CMYK)).toBe(1_129_142_603);
  });
});
