declare module "indesign" {
  export const app: unknown;
  export const ScriptLanguage: {
    readonly UXPSCRIPT: unknown;
  };
  export const UndoModes: {
    readonly ENTIRE_SCRIPT: unknown;
  };
  export const ExportFormat: Readonly<Record<string, unknown>>;
  export const PNGExportRangeEnum: Readonly<Record<string, unknown>>;
  export const ExportRangeOrAllPages: Readonly<Record<string, unknown>>;
  export const PageRange: Readonly<Record<string, unknown>>;
  export const FontStatus: Readonly<Record<string, unknown>>;
  export const LinkStatus: Readonly<Record<string, unknown>>;
  export const ColorSpace: Readonly<Record<string, unknown>>;
  export const ColorModel: Readonly<Record<string, unknown>>;
  export const Justification: Readonly<Record<string, unknown>>;
  export const AnchorPoint: Readonly<Record<string, unknown>>;
  export const BoundingBoxLimits: Readonly<Record<string, unknown>>;
  export const CoordinateSpaces: Readonly<Record<string, unknown>>;
  export const LocationOptions: Readonly<Record<string, unknown>>;
}
