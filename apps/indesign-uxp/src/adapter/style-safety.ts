import type { Operation } from "@sol/protocol";
import { SafeBridgeError } from "../core/errors";
import { getMember, hasMethod, setMember } from "../core/records";

type ParagraphJustification = NonNullable<
  Extract<Operation, { type: "create_or_update_paragraph_style" }>["properties"]["justification"]
>;

const JUSTIFICATION_KEYS: Readonly<Record<ParagraphJustification, string>> = {
  left: "LEFT_ALIGN",
  center: "CENTER_ALIGN",
  right: "RIGHT_ALIGN",
  justify: "LEFT_JUSTIFIED",
};

export function resolveJustification(
  justification: ParagraphJustification,
  enumValues: Readonly<Record<string, unknown>>,
): unknown {
  const key = JUSTIFICATION_KEYS[justification];
  const value = enumValues[key];
  if (value === undefined) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `InDesign does not expose Justification.${key}.`);
  }
  return value;
}

export function enableObjectStyleAppearanceCategories(
  style: unknown,
  properties: Extract<Operation, { type: "create_or_update_object_style" }>["properties"],
): void {
  if (properties.fillColor !== undefined) setMember(style, "enableFill", true);
  if (properties.strokeColor !== undefined || properties.strokeWeightPt !== undefined) {
    setMember(style, "enableStroke", true);
  }
  if (properties.opacity !== undefined) {
    const effects = getMember(style, "objectEffectsEnablingSettings");
    if (effects === undefined) {
      throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "This InDesign runtime cannot enable object-style transparency.");
    }
    setMember(effects, "enableTransparency", true);
  }
}

export function setDocumentedOpacity(target: unknown, opacity: number): void {
  const transparency = getMember(target, "transparencySettings");
  const blending = getMember(transparency, "blendingSettings");
  if (transparency === undefined || blending === undefined) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "This InDesign runtime does not expose documented transparency blending settings.",
    );
  }
  setMember(blending, "opacity", opacity);
}

export function assertClearOverridesCapability(
  target: unknown,
  method: "applyParagraphStyle" | "applyObjectStyle",
  clearOverrides: boolean,
): void {
  if (clearOverrides && !hasMethod(target, method)) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "This InDesign runtime cannot clear style overrides safely.",
    );
  }
}
