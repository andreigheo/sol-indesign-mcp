export const DOCUMENTED_PAGE_COORDINATES = 2_021_224_551;
export const DOCUMENTED_TOP_LEFT_ANCHOR = 1_095_660_652;
export const DOCUMENTED_BOTTOM_RIGHT_ANCHOR = 1_095_656_050;
export const DOCUMENTED_GEOMETRIC_PATH_BOUNDS = 1_768_844_080;
export const DOCUMENTED_EXPORT_FORMAT_PDF_TYPE = 1_952_403_524;
export const DOCUMENTED_EXPORT_FORMAT_PNG_FORMAT = 1_699_761_735;
export const DOCUMENTED_EXPORT_FORMAT_JPG = 1_246_775_072;
export const DOCUMENTED_EXPORT_FORMAT_INDESIGN_MARKUP = 1_768_189_292;
export const DOCUMENTED_EXPORT_RANGE = 1_785_742_674;
export const DOCUMENTED_PAGE_RANGE_ALL_PAGES = 1_886_547_553;
export const DOCUMENTED_FONT_STATUS_NOT_AVAILABLE = 1_718_832_705;
export const DOCUMENTED_FONT_STATUS_SUBSTITUTED = 1_718_834_037;
export const DOCUMENTED_LINK_STATUS_MISSING = 1_819_109_747;
export const DOCUMENTED_LINK_STATUS_INACCESSIBLE = 1_818_848_865;
export const DOCUMENTED_LINK_STATUS_OUT_OF_DATE = 1_819_242_340;
export const DOCUMENTED_COLOR_MODEL_PROCESS = 1_886_548_851;
export const DOCUMENTED_COLOR_SPACE_RGB = 1_666_336_578;
export const DOCUMENTED_COLOR_SPACE_CMYK = 1_129_142_603;

export function resolveDocumentedHostEnum(
  runtimeValue: unknown,
  documentedValue: number,
): string | number {
  return isPrimitiveEnumValue(runtimeValue) ? runtimeValue : documentedValue;
}

function isPrimitiveEnumValue(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0)
    || (typeof value === "number" && Number.isFinite(value));
}
