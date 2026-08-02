import { boundsToDom } from "@sol/domain";
import type { InDesignObjectRef, ObjectTarget, Operation, ResourceTarget } from "@sol/protocol";
import {
  AnchorPoint,
  BoundingBoxLimits,
  ColorModel,
  ColorSpace,
  CoordinateSpaces,
  Justification,
  LocationOptions,
} from "indesign";
import type { UxpFile } from "uxp";
import { SafeBridgeError } from "../core/errors";
import { callMember, collectionItems, collectionLength, getMember, hasMethod, setMember } from "../core/records";
import { executeWithStrictFileEntryFallback } from "../security/dom-file-fallback";
import type { WorkspaceManager } from "../security/workspace";
import {
  DOCUMENTED_BOTTOM_RIGHT_ANCHOR,
  DOCUMENTED_COLOR_MODEL_PROCESS,
  DOCUMENTED_COLOR_SPACE_CMYK,
  DOCUMENTED_COLOR_SPACE_RGB,
  DOCUMENTED_GEOMETRIC_PATH_BOUNDS,
  DOCUMENTED_PAGE_COORDINATES,
  DOCUMENTED_TOP_LEFT_ANCHOR,
  resolveDocumentedHostEnum,
} from "./host-enums";
import type { IdentityRegistry } from "./identity";
import { reframePageRelativeBounds } from "./page-geometry";
import {
  PAGE_ITEM_KINDS,
  PAGE_KIND,
  PLACE_TARGET_KINDS,
  TEXT_KIND,
  assertSemanticTargetKind,
} from "./semantic-target";
import {
  assertClearOverridesCapability,
  enableObjectStyleAppearanceCategories,
  resolveJustification,
  setDocumentedOpacity,
} from "./style-safety";
import { assertMutableResourceName, assertMutableResourceObject } from "./resource-safety";

interface VirtualObject {
  readonly virtual: true;
  readonly kind: string;
  readonly operationIndex: number;
  readonly groupingContainerKey?: string;
  readonly groupingContainer?: unknown;
  readonly groupingLocked?: boolean;
  readonly groupingLayerLocked?: boolean;
}

interface GroupingContainer {
  readonly key: string;
  readonly owner: unknown;
}

interface GroupedMember {
  readonly item: unknown;
  readonly reference: InDesignObjectRef;
}

type AliasValue = unknown;
type MarkMutation = () => void;

const PAGE_GEOMETRY_ENUMS = {
  pageCoordinates: resolveDocumentedHostEnum(
    CoordinateSpaces.PAGE_COORDINATES,
    DOCUMENTED_PAGE_COORDINATES,
  ),
  geometricPathBounds: resolveDocumentedHostEnum(
    BoundingBoxLimits.GEOMETRIC_PATH_BOUNDS,
    DOCUMENTED_GEOMETRIC_PATH_BOUNDS,
  ),
  topLeftAnchor: resolveDocumentedHostEnum(
    AnchorPoint.TOP_LEFT_ANCHOR,
    DOCUMENTED_TOP_LEFT_ANCHOR,
  ),
  bottomRightAnchor: resolveDocumentedHostEnum(
    AnchorPoint.BOTTOM_RIGHT_ANCHOR,
    DOCUMENTED_BOTTOM_RIGHT_ANCHOR,
  ),
};
const MAX_GROUPING_PAGE_ITEMS = 10_000;

export interface PreparedOperations {
  readonly operations: readonly Operation[];
  readonly files: ReadonlyMap<number, UxpFile>;
  readonly warnings: readonly string[];
}

export interface ExecutionSummary {
  readonly aliases: Record<string, InDesignObjectRef>;
  readonly completed: number;
}

export interface ExecutionProgress {
  mutationStarted: boolean;
  completed: number;
  aliases: Record<string, InDesignObjectRef>;
}

export function createExecutionProgress(): ExecutionProgress {
  return { mutationStarted: false, completed: 0, aliases: {} };
}

export async function prepareOperations(
  document: unknown,
  operations: readonly Operation[],
  identity: IdentityRegistry,
  workspace: WorkspaceManager,
): Promise<PreparedOperations> {
  const aliases = new Map<string, AliasValue>();
  const files = new Map<number, UxpFile>();
  const warnings: string[] = [];

  for (const [index, operation] of operations.entries()) {
    if (operation.ref !== undefined && aliases.has(operation.ref)) {
      throw new SafeBridgeError("INVALID_INPUT", `Operation alias '${operation.ref}' is declared more than once.`);
    }
    const produced = await validateOperation(document, operation, index, aliases, identity, workspace, files);
    if (operation.ref !== undefined) aliases.set(operation.ref, produced ?? virtual(operation.type, index));
  }
  return { operations, files, warnings };
}

export function executePreparedOperations(
  document: unknown,
  plan: PreparedOperations,
  identity: IdentityRegistry,
  workspace: WorkspaceManager,
  progress: ExecutionProgress = createExecutionProgress(),
): ExecutionSummary {
  const aliases = new Map<string, AliasValue>();
  for (const [index, operation] of plan.operations.entries()) {
    try {
      const result = executeOperation(
        document,
        operation,
        index,
        aliases,
        identity,
        workspace,
        plan.files,
        () => { progress.mutationStarted = true; },
      );
      if (result === undefined) throw new SafeBridgeError("UXP_OPERATION_FAILED", `${operation.type} did not return its modified or created object.`);
      // Persisting first-write identity is itself a sanctioned document mutation.
      progress.mutationStarted = true;
      identity.objectRef(document, result, true);
      progress.completed += 1;
      if (operation.ref !== undefined) aliases.set(operation.ref, result);
      refreshProgressAliases(document, aliases, identity, progress);
    } catch (error: unknown) {
      if (!progress.mutationStarted && error instanceof SafeBridgeError) throw error;
      const failureMetadata = safeFailureMetadata(error);
      throw new SafeBridgeError("UXP_OPERATION_FAILED", "InDesign could not complete the operation batch.", {
        details: {
          completedOperationCount: progress.completed,
          failedOperationIndex: index,
          failedOperationType: operation.type,
          failureCode: error instanceof SafeBridgeError ? error.code : "UXP_OPERATION_FAILED",
          ...failureMetadata,
          aliases: progress.aliases,
          partialChanges: progress.mutationStarted,
        },
      });
    }
  }
  return { aliases: progress.aliases, completed: progress.completed };
}

async function validateOperation(
  document: unknown,
  operation: Operation,
  index: number,
  aliases: ReadonlyMap<string, AliasValue>,
  identity: IdentityRegistry,
  workspace: WorkspaceManager,
  files: Map<number, UxpFile>,
): Promise<AliasValue> {
  switch (operation.type) {
    case "ensure_layer": {
      assertMutableResourceName(operation.name);
      const existing = findNamed(document, "layers", operation.name);
      return virtual("layer", index, {
        groupingLocked: operation.locked ?? (existing !== undefined && getMember(existing, "locked") === true),
      });
    }
    case "create_page":
      if (operation.after !== undefined) {
        resolveTarget(document, operation.after, aliases, identity, true, PAGE_KIND, "create_page.after");
      }
      return virtual("page", index, { groupingContainerKey: `planned-page:${index}` });
    case "create_rectangle":
    case "create_oval":
    case "create_text_frame": {
      const page = resolveTarget(document, operation.page, aliases, identity, true, PAGE_KIND, `${operation.type}.page`);
      if (!isVirtual(page)) {
        const collectionName = operation.type === "create_rectangle"
          ? "rectangles"
          : operation.type === "create_oval" ? "ovals" : "textFrames";
        requireCollection(page, collectionName);
      }
      const layer = operation.layer === undefined
        ? undefined
        : resolveResource(document, operation.layer, "layers", aliases, identity, true);
      boundsToDom(operation.bounds);
      const kind = operation.type === "create_rectangle"
        ? "rectangle"
        : operation.type === "create_oval" ? "oval" : "text_frame";
      const groupingContainer = plannedPageItemGroupingContainer(page);
      return virtual(kind, index, {
        groupingContainerKey: groupingContainer.key,
        groupingContainer: groupingContainer.owner,
        groupingLayerLocked: virtualOrRealLocked(layer),
      });
    }
    case "set_text":
      return resolveTarget(document, operation.target, aliases, identity, true, TEXT_KIND, "set_text.target");
    case "set_item_bounds":
      boundsToDom(operation.bounds);
      return resolveTarget(document, operation.target, aliases, identity, true, PAGE_ITEM_KINDS, "set_item_bounds.target");
    case "set_item_appearance": {
      const target = resolveTarget(document, operation.target, aliases, identity, true, PAGE_ITEM_KINDS, "set_item_appearance.target");
      if (operation.fillColor !== undefined) resolveResource(document, operation.fillColor, "colors", aliases, identity, true);
      if (operation.strokeColor !== undefined) resolveResource(document, operation.strokeColor, "colors", aliases, identity, true);
      return target;
    }
    case "create_or_update_color":
      assertMutableResourceName(operation.name);
      requireCollection(document, "colors");
      closedColorProperties(operation);
      return findNamed(document, "colors", operation.name) ?? virtual("color", index);
    case "create_or_update_paragraph_style": {
      assertMutableResourceName(operation.name);
      if (operation.properties.fillColor !== undefined) {
        resolveResource(document, operation.properties.fillColor, "colors", aliases, identity, true);
      }
      if (operation.properties.fontFamily !== undefined) validateFont(document, operation.properties.fontFamily, operation.properties.fontStyle);
      return findNamed(document, "paragraphStyles", operation.name) ?? virtual("paragraph_style", index);
    }
    case "apply_paragraph_style":
      resolveResource(document, operation.style, "paragraphStyles", aliases, identity, true);
      return resolveTarget(document, operation.target, aliases, identity, true, TEXT_KIND, "apply_paragraph_style.target");
    case "create_or_update_object_style": {
      assertMutableResourceName(operation.name);
      if (operation.properties.fillColor !== undefined) {
        resolveResource(document, operation.properties.fillColor, "colors", aliases, identity, true);
      }
      if (operation.properties.strokeColor !== undefined) {
        resolveResource(document, operation.properties.strokeColor, "colors", aliases, identity, true);
      }
      return findNamed(document, "objectStyles", operation.name) ?? virtual("object_style", index);
    }
    case "apply_object_style":
      resolveResource(document, operation.style, "objectStyles", aliases, identity, true);
      return resolveTarget(document, operation.target, aliases, identity, true, PAGE_ITEM_KINDS, "apply_object_style.target");
    case "place_file": {
      const target = resolveTarget(document, operation.target, aliases, identity, true, PLACE_TARGET_KINDS, "place_file.target");
      const entry = await workspace.resolveExisting(operation.path, "file");
      if (!entry.isFile) throw new SafeBridgeError("PATH_NOT_ALLOWED", "Placed content must be a file.");
      files.set(index, entry as UxpFile);
      return target;
    }
    case "group_items": {
      const targets = operation.targets.map((target) => (
        resolveTarget(document, target, aliases, identity, true, PAGE_ITEM_KINDS, "group_items.targets")
      ));
      const layer = operation.layer === undefined
        ? undefined
        : resolveResource(document, operation.layer, "layers", aliases, identity, true);
      const groupingContainer = assertGroupableTargets(document, targets, layer, identity, true);
      requireCollection(groupingContainer.owner, "groups");
      return virtual("group", index, {
        groupingContainerKey: groupingContainer.key,
        groupingContainer: groupingContainer.owner,
        groupingLayerLocked: virtualOrRealLocked(layer),
      });
    }
    case "move_item_to_layer":
      resolveResource(document, operation.layer, "layers", aliases, identity, true);
      return resolveTarget(document, operation.target, aliases, identity, true, PAGE_ITEM_KINDS, "move_item_to_layer.target");
  }
}

function executeOperation(
  document: unknown,
  operation: Operation,
  index: number,
  aliases: Map<string, AliasValue>,
  identity: IdentityRegistry,
  workspace: WorkspaceManager,
  files: ReadonlyMap<number, UxpFile>,
  markMutation: MarkMutation,
): unknown {
  switch (operation.type) {
    case "ensure_layer": {
      let layer = findNamed(document, "layers", operation.name);
      if (layer === undefined) {
        markMutation();
        layer = addToCollection(document, "layers");
      } else {
        assertMutableResourceObject(layer, operation.name);
      }
      markMutation();
      setMember(layer, "name", operation.name);
      if (operation.visible !== undefined) setMember(layer, "visible", operation.visible);
      if (operation.printable !== undefined) setMember(layer, "printable", operation.printable);
      if (operation.locked !== undefined) setMember(layer, "locked", operation.locked);
      return layer;
    }
    case "create_page": {
      const pages = requireCollection(document, "pages");
      if (operation.after === undefined) {
        markMutation();
        return callMember(pages, "add");
      }
      const after = requireReal(resolveTarget(document, operation.after, aliases, identity, false, PAGE_KIND, "create_page.after"));
      const afterLocation = LocationOptions.AFTER;
      if (afterLocation === undefined) {
        throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign does not expose LocationOptions.AFTER.");
      }
      markMutation();
      return callMember(pages, "add", [afterLocation, after]);
    }
    case "create_rectangle":
      return createPageItem(document, operation.page, operation.layer, operation.bounds, "rectangles", aliases, identity, markMutation);
    case "create_oval":
      return createPageItem(document, operation.page, operation.layer, operation.bounds, "ovals", aliases, identity, markMutation);
    case "create_text_frame": {
      const frame = createPageItem(document, operation.page, operation.layer, operation.bounds, "textFrames", aliases, identity, markMutation);
      if (operation.text !== undefined) setMember(frame, "contents", operation.text);
      return frame;
    }
    case "set_text": {
      const target = requireReal(resolveTarget(document, operation.target, aliases, identity, false, TEXT_KIND, "set_text.target"));
      markMutation();
      setMember(target, "contents", operation.text);
      return target;
    }
    case "set_item_bounds": {
      const target = requireReal(resolveTarget(document, operation.target, aliases, identity, false, PAGE_ITEM_KINDS, "set_item_bounds.target"));
      markMutation();
      reframePageRelativeBounds(target, operation.bounds, PAGE_GEOMETRY_ENUMS);
      return target;
    }
    case "set_item_appearance": {
      const target = requireReal(resolveTarget(document, operation.target, aliases, identity, false, PAGE_ITEM_KINDS, "set_item_appearance.target"));
      const fillColor = operation.fillColor === undefined
        ? undefined
        : requireReal(resolveResource(document, operation.fillColor, "colors", aliases, identity, false));
      const strokeColor = operation.strokeColor === undefined
        ? undefined
        : requireReal(resolveResource(document, operation.strokeColor, "colors", aliases, identity, false));
      if (fillColor !== undefined) { markMutation(); setMember(target, "fillColor", fillColor); }
      if (strokeColor !== undefined) { markMutation(); setMember(target, "strokeColor", strokeColor); }
      if (operation.fillTint !== undefined) { markMutation(); setMember(target, "fillTint", operation.fillTint); }
      if (operation.strokeTint !== undefined) { markMutation(); setMember(target, "strokeTint", operation.strokeTint); }
      if (operation.strokeWeightPt !== undefined) { markMutation(); setMember(target, "strokeWeight", operation.strokeWeightPt); }
      if (operation.opacity !== undefined) { markMutation(); setOpacity(target, operation.opacity); }
      return target;
    }
    case "create_or_update_color": {
      const properties = closedColorProperties(operation);
      let color = findNamed(document, "colors", operation.name);
      if (color === undefined) {
        const colors = requireCollection(document, "colors");
        markMutation();
        color = withColorFailureStage("color.add", () => callMember(colors, "add", [properties]));
      } else {
        assertMutableResourceObject(color, operation.name);
        markMutation();
        withColorFailureStage("color.properties", () => setMember(color, "properties", properties));
      }
      if (!isValid(color)) {
        throw new SafeBridgeError(
          "UXP_OPERATION_FAILED",
          "InDesign did not return a valid color after the atomic color operation.",
          { details: { failedStage: "color.result" } },
        );
      }
      return color;
    }
    case "create_or_update_paragraph_style": {
      if (operation.properties.fontFamily !== undefined) {
        validateFont(document, operation.properties.fontFamily, operation.properties.fontStyle);
      }
      const fillColor = operation.properties.fillColor === undefined
        ? undefined
        : requireReal(resolveResource(document, operation.properties.fillColor, "colors", aliases, identity, false));
      const justification = operation.properties.justification === undefined
        ? undefined
        : resolveJustification(operation.properties.justification, Justification);
      let style = findNamed(document, "paragraphStyles", operation.name);
      if (style === undefined) {
        markMutation();
        style = addToCollection(document, "paragraphStyles");
      } else {
        assertMutableResourceObject(style, operation.name);
      }
      markMutation();
      setMember(style, "name", operation.name);
      applyParagraphStyleProperties(style, operation.properties, fillColor, justification);
      return style;
    }
    case "apply_paragraph_style": {
      const target = requireReal(resolveTarget(document, operation.target, aliases, identity, false, TEXT_KIND, "apply_paragraph_style.target"));
      const style = requireReal(resolveResource(document, operation.style, "paragraphStyles", aliases, identity, false));
      const paragraphs = getMember(target, "paragraphs");
      if (paragraphs !== undefined && hasMethod(paragraphs, "everyItem")) {
        const every = callMember(paragraphs, "everyItem");
        assertClearOverridesCapability(every, "applyParagraphStyle", operation.clearOverrides);
        markMutation();
        if (hasMethod(every, "applyParagraphStyle")) callMember(every, "applyParagraphStyle", [style, operation.clearOverrides]);
        else setMember(every, "appliedParagraphStyle", style);
      } else {
        assertClearOverridesCapability(target, "applyParagraphStyle", operation.clearOverrides);
        markMutation();
        if (hasMethod(target, "applyParagraphStyle")) callMember(target, "applyParagraphStyle", [style, operation.clearOverrides]);
        else setMember(target, "appliedParagraphStyle", style);
      }
      return target;
    }
    case "create_or_update_object_style": {
      const fillColor = operation.properties.fillColor === undefined
        ? undefined
        : requireReal(resolveResource(document, operation.properties.fillColor, "colors", aliases, identity, false));
      const strokeColor = operation.properties.strokeColor === undefined
        ? undefined
        : requireReal(resolveResource(document, operation.properties.strokeColor, "colors", aliases, identity, false));
      let style = findNamed(document, "objectStyles", operation.name);
      if (style === undefined) {
        markMutation();
        style = addToCollection(document, "objectStyles");
      } else {
        assertMutableResourceObject(style, operation.name);
      }
      markMutation();
      setMember(style, "name", operation.name);
      enableObjectStyleAppearanceCategories(style, operation.properties);
      applyObjectStyleProperties(style, operation.properties, fillColor, strokeColor);
      return style;
    }
    case "apply_object_style": {
      const target = requireReal(resolveTarget(document, operation.target, aliases, identity, false, PAGE_ITEM_KINDS, "apply_object_style.target"));
      const style = requireReal(resolveResource(document, operation.style, "objectStyles", aliases, identity, false));
      assertClearOverridesCapability(target, "applyObjectStyle", operation.clearOverrides);
      markMutation();
      if (hasMethod(target, "applyObjectStyle")) callMember(target, "applyObjectStyle", [style, operation.clearOverrides]);
      else setMember(target, "appliedObjectStyle", style);
      return target;
    }
    case "place_file": {
      const target = requireReal(resolveTarget(document, operation.target, aliases, identity, false, PLACE_TARGET_KINDS, "place_file.target"));
      const file = files.get(index);
      if (file === undefined) throw new SafeBridgeError("PATH_NOT_ALLOWED", "The prepared placement file is unavailable.");
      markMutation();
      executeWithStrictFileEntryFallback(
        file,
        () => workspace.nativePathForDom(file),
        (domFile) => callMember(target, "place", [domFile]),
      );
      return target;
    }
    case "group_items": {
      const targets = operation.targets.map((target) => requireReal(
        resolveTarget(document, target, aliases, identity, false, PAGE_ITEM_KINDS, "group_items.targets"),
      ));
      const layer = operation.layer === undefined
        ? undefined
        : requireReal(resolveResource(document, operation.layer, "layers", aliases, identity, false));
      const groupingContainer = assertGroupableTargets(document, targets, layer, identity, false);
      const groups = requireCollection(groupingContainer.owner, "groups");
      const groupItems = documentedGroupingSpecifier(groupingContainer.owner, targets, document, identity);
      const expectedMembers = persistGroupingTargetIdentities(document, targets, identity, markMutation);
      markMutation();
      const group = withGroupFailureStage("group.add", () => callMember(
        groups,
        "add",
        layer === undefined ? [groupItems] : [groupItems, layer],
      ));
      const groupedMembers = assertCreatedGroup(document, group, expectedMembers, identity);
      reconcileGroupedTargetAliases(operation.targets, expectedMembers, groupedMembers, aliases);
      return group;
    }
    case "move_item_to_layer": {
      const target = requireReal(resolveTarget(document, operation.target, aliases, identity, false, PAGE_ITEM_KINDS, "move_item_to_layer.target"));
      const layer = requireReal(resolveResource(document, operation.layer, "layers", aliases, identity, false));
      markMutation();
      setMember(target, "itemLayer", layer);
      return target;
    }
  }
}

function createPageItem(
  document: unknown,
  pageTarget: ObjectTarget,
  layerTarget: ResourceTarget | undefined,
  bounds: Parameters<typeof boundsToDom>[0],
  collectionName: "rectangles" | "ovals" | "textFrames",
  aliases: ReadonlyMap<string, AliasValue>,
  identity: IdentityRegistry,
  markMutation: MarkMutation,
): unknown {
  const page = requireReal(resolveTarget(document, pageTarget, aliases, identity, false, PAGE_KIND, `${collectionName}.page`));
  const collection = requireCollection(page, collectionName);
  const layer = layerTarget === undefined ? undefined : requireReal(resolveResource(document, layerTarget, "layers", aliases, identity, false));
  markMutation();
  const item = callMember(collection, "add", layer === undefined ? [] : [layer]);
  reframePageRelativeBounds(item, bounds, PAGE_GEOMETRY_ENUMS);
  return item;
}

function resolveTarget(
  document: unknown,
  target: ObjectTarget,
  aliases: ReadonlyMap<string, AliasValue>,
  identity: IdentityRegistry,
  allowVirtual: boolean,
  allowedKinds: readonly InDesignObjectRef["kind"][],
  operation: string,
): AliasValue {
  let value: AliasValue;
  if ("ref" in target) {
    value = aliases.get(target.ref);
    if (value === undefined) throw new SafeBridgeError("INVALID_INPUT", `Alias '${target.ref}' must refer to an earlier operation.`);
    if (!allowVirtual && isVirtual(value)) throw new SafeBridgeError("UXP_OPERATION_FAILED", `Alias '${target.ref}' was not materialized.`);
  } else {
    value = identity.resolveObject(document, target.objectRef, target.expectedFingerprint);
  }
  const kind = isVirtual(value) ? value.kind : identity.kindOf(value, document);
  assertSemanticTargetKind(kind, allowedKinds, operation);
  return value;
}

function resolveResource(
  document: unknown,
  target: ResourceTarget,
  collectionName: "layers" | "colors" | "paragraphStyles" | "objectStyles",
  aliases: ReadonlyMap<string, AliasValue>,
  identity: IdentityRegistry,
  allowVirtual: boolean,
): AliasValue {
  const resourceKind = resourceKindForCollection(collectionName);
  if ("ref" in target) {
    const value = aliases.get(target.ref);
    if (value === undefined) throw new SafeBridgeError("INVALID_INPUT", `Alias '${target.ref}' must refer to an earlier operation.`);
    if (!allowVirtual && isVirtual(value)) throw new SafeBridgeError("UXP_OPERATION_FAILED", `Alias '${target.ref}' was not materialized.`);
    assertSemanticTargetKind(isVirtual(value) ? value.kind : identity.kindOf(value, document), [resourceKind], `${collectionName} resource`);
    return value;
  }
  if ("objectRef" in target) {
    const value = identity.resolveObject(document, target.objectRef);
    assertSemanticTargetKind(identity.kindOf(value, document), [resourceKind], `${collectionName} resource`);
    return value;
  }
  const named = findNamed(document, collectionName, target.name);
  if (named === undefined) {
    const code = collectionName === "paragraphStyles" || collectionName === "objectStyles"
      ? "STYLE_NOT_FOUND"
      : "ITEM_NOT_FOUND";
    throw new SafeBridgeError(code, `${collectionName} resource '${target.name}' does not exist.`);
  }
  return named;
}

function requireCollection(owner: unknown, name: string): unknown {
  const collection = getMember(owner, name);
  if (collection === undefined || !hasMethod(collection, "add")) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `InDesign does not expose ${name}.add.`);
  }
  return collection;
}

function addToCollection(owner: unknown, name: string): unknown {
  return callMember(requireCollection(owner, name), "add");
}

interface ClosedColorProperties {
  readonly name: string;
  readonly model: string | number;
  readonly space: string | number;
  readonly colorValue: readonly number[];
}

function closedColorProperties(
  operation: Extract<Operation, { type: "create_or_update_color" }>,
): ClosedColorProperties {
  return {
    name: operation.name,
    model: resolveDocumentedHostEnum(ColorModel.PROCESS, DOCUMENTED_COLOR_MODEL_PROCESS),
    space: operation.color.space === "RGB"
      ? resolveDocumentedHostEnum(ColorSpace.RGB, DOCUMENTED_COLOR_SPACE_RGB)
      : resolveDocumentedHostEnum(ColorSpace.CMYK, DOCUMENTED_COLOR_SPACE_CMYK),
    colorValue: [...operation.color.values],
  };
}

function withColorFailureStage<T>(stage: "color.add" | "color.properties", action: () => T): T {
  try {
    return action();
  } catch (error: unknown) {
    if (error instanceof SafeBridgeError) {
      throw new SafeBridgeError(error.code, error.message, {
        retryable: error.retryable,
        details: { ...(error.details ?? {}), failedStage: stage },
      });
    }
    throw new SafeBridgeError(
      "UXP_OPERATION_FAILED",
      "InDesign rejected the atomic color operation.",
      { details: { failedStage: stage } },
    );
  }
}

function withGroupFailureStage<T>(stage: "group.add", action: () => T): T {
  try {
    return action();
  } catch (error: unknown) {
    if (error instanceof SafeBridgeError) {
      throw new SafeBridgeError(error.code, error.message, {
        retryable: error.retryable,
        details: { ...(error.details ?? {}), failedStage: stage },
      });
    }
    throw new SafeBridgeError(
      "UXP_OPERATION_FAILED",
      "InDesign rejected the grouping operation.",
      { details: { failedStage: stage } },
    );
  }
}

function assertGroupableTargets(
  document: unknown,
  targets: readonly AliasValue[],
  layer: AliasValue,
  identity: IdentityRegistry,
  allowVirtual: boolean,
): GroupingContainer {
  if (targets.length < 2) {
    throw new SafeBridgeError("INVALID_INPUT", "group_items requires at least two targets.");
  }
  const identities = new Set<string>();
  let groupingContainer: GroupingContainer | undefined;
  for (const target of targets) {
    if (isVirtual(target)) {
      if (!allowVirtual) throw new SafeBridgeError("UXP_OPERATION_FAILED", "A dry-run grouping placeholder reached DOM execution.");
      const key = `virtual:${target.operationIndex}`;
      if (identities.has(key)) throw new SafeBridgeError("INVALID_INPUT", "group_items targets must be unique.");
      identities.add(key);
      if (target.groupingLocked === true) throw new SafeBridgeError("INVALID_INPUT", "group_items target is locked.");
      if (target.groupingLayerLocked === true) throw new SafeBridgeError("INVALID_INPUT", "group_items target layer is locked.");
      const currentContainerKey = target.groupingContainerKey;
      if (currentContainerKey === undefined) {
        throw new SafeBridgeError(
          "UNSUPPORTED_CAPABILITY",
          "Dry-run could not prove the grouping container for an earlier operation alias.",
        );
      }
      const currentContainer = { key: currentContainerKey, owner: target.groupingContainer };
      if (groupingContainer === undefined) groupingContainer = currentContainer;
      else if (groupingContainer.key !== currentContainer.key) {
        throw new SafeBridgeError("INVALID_INPUT", "group_items targets must belong to the same spread or container.");
      } else if (!isValid(groupingContainer.owner) && isValid(currentContainer.owner)) {
        groupingContainer = currentContainer;
      }
      continue;
    }
    const reference = identity.objectRef(document, target);
    const key = `${reference.kind}:${reference.nativeId}`;
    if (identities.has(key)) throw new SafeBridgeError("INVALID_INPUT", "group_items targets must be unique.");
    identities.add(key);
    assertUnlockedForGrouping(target, "group_items target");
    const itemLayer = getMember(target, "itemLayer");
    if (isValid(itemLayer)) assertUnlockedForGrouping(itemLayer, "group_items target layer");
    const currentContainer = groupingContainerForTarget(target);
    if (groupingContainer === undefined) groupingContainer = currentContainer;
    else if (groupingContainer.key !== currentContainer.key) {
      throw new SafeBridgeError("INVALID_INPUT", "group_items targets must belong to the same spread or container.");
    }
  }
  if (layer !== undefined) {
    if (isVirtual(layer)) {
      if (layer.groupingLocked === true) {
        throw new SafeBridgeError("INVALID_INPUT", "group_items destination layer is locked.");
      }
    } else {
      assertUnlockedForGrouping(layer, "group_items destination layer");
    }
  }
  if (groupingContainer === undefined) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "Dry-run could not prove a grouping container.");
  }
  if (!isValid(groupingContainer.owner)) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "Dry-run could not prove the documented Groups.add owner for the target container.",
    );
  }
  return groupingContainer;
}

function assertUnlockedForGrouping(value: unknown, label: string): void {
  if (getMember(value, "locked") === true) {
    throw new SafeBridgeError("INVALID_INPUT", `${label} is locked.`);
  }
}

function groupingContainerForTarget(target: unknown): GroupingContainer {
  const directParent = getMember(target, "parent");
  if (isValid(directParent)) return stableGroupingContainer(directParent);
  const parentPage = getMember(target, "parentPage");
  const pageParent = isValid(parentPage) ? getMember(parentPage, "parent") : undefined;
  return stableGroupingContainer(pageParent);
}

function plannedPageItemGroupingContainer(page: AliasValue): GroupingContainer {
  if (isVirtual(page)) {
    if (page.groupingContainerKey === undefined) {
      throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "Dry-run could not prove the planned page container.");
    }
    return { key: page.groupingContainerKey, owner: page.groupingContainer };
  }
  return stableGroupingContainer(getMember(page, "parent"));
}

function stableGroupingContainer(container: unknown): GroupingContainer {
  return { key: stableContainerKey(container), owner: container };
}

function stableContainerKey(container: unknown): string {
  if (!isValid(container)) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign did not expose a stable grouping container for a target.");
  }
  const id = Number(getMember(container, "id"));
  if (!Number.isInteger(id) || id < 0) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign did not expose a stable native ID for a grouping container.");
  }
  const reflectName = safeResourceText(getMember(getMember(container, "reflect"), "name"));
  return `${reflectName.toLowerCase()}:${id}`;
}

function virtualOrRealLocked(value: AliasValue): boolean {
  if (value === undefined) return false;
  return isVirtual(value) ? value.groupingLocked === true : getMember(value, "locked") === true;
}

function documentedGroupingSpecifier(
  owner: unknown,
  targets: readonly unknown[],
  document: unknown,
  identity: IdentityRegistry,
): unknown {
  const pageItems = getMember(owner, "pageItems");
  const pageItemCount = collectionLength(pageItems);
  if (pageItemCount === undefined) {
    throw groupingSpecifierError(
      "InDesign did not expose a bounded page-item collection for exact grouping.",
      "collection-length-unavailable",
    );
  }
  if (pageItemCount > MAX_GROUPING_PAGE_ITEMS) {
    throw groupingSpecifierError(
      "The grouping container exceeds the bounded exact-range validation limit.",
      "collection-limit-exceeded",
    );
  }
  const ownerPageItems = collectionItems(pageItems, MAX_GROUPING_PAGE_ITEMS);
  if (ownerPageItems.length !== pageItemCount) {
    throw groupingSpecifierError(
      "InDesign did not resolve every indexed page item in the grouping container.",
      "collection-resolution-incomplete",
    );
  }
  const expected = new Set(targets.map((target) => stableObjectKey(document, target, identity)));
  const indexedTargets = ownerPageItems.flatMap((target, index) => (
    expected.has(stableObjectKey(document, target, identity)) ? [{ target, index }] : []
  ));
  if (indexedTargets.length !== targets.length) {
    throw groupingSpecifierError(
      "The requested group targets were not found exactly once in the common page-item collection.",
      "target-position-unresolved",
    );
  }
  const first = indexedTargets[0];
  const last = indexedTargets[indexedTargets.length - 1];
  if (first === undefined || last === undefined || last.index - first.index + 1 !== targets.length) {
    throw groupingSpecifierError(
      "The requested group targets are not one exact contiguous page-item range.",
      "targets-not-contiguous",
    );
  }
  if (!hasMethod(pageItems, "itemByRange")) {
    throw groupingSpecifierError(
      "This InDesign runtime does not expose PageItems.itemByRange for exact grouping.",
      "item-by-range-unavailable",
    );
  }
  let specifier: unknown;
  let resolved: unknown[];
  try {
    specifier = callMember(pageItems, "itemByRange", [first.index, last.index]);
    if (!isValid(specifier) || !hasMethod(specifier, "getElements")) {
      throw groupingSpecifierError(
        "InDesign did not return a resolvable page-item range for grouping.",
        "range-specifier-invalid",
      );
    }
    const elements = callMember(specifier, "getElements");
    if (!Array.isArray(elements)) {
      throw groupingSpecifierError(
        "InDesign returned an unsupported page-item range resolution shape.",
        "range-resolution-shape",
      );
    }
    resolved = elements.slice(0, 101);
  } catch (error: unknown) {
    if (error instanceof SafeBridgeError) throw error;
    throw groupingSpecifierError(
      "InDesign rejected the documented page-item range used for grouping.",
      "range-resolution-rejected",
    );
  }
  const actual = new Set(resolved.map((target) => stableObjectKey(document, target, identity)));
  if (resolved.length !== targets.length || actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
    throw groupingSpecifierError(
      "The documented page-item range includes objects outside the requested group.",
      "range-membership-mismatch",
    );
  }
  return specifier;
}

function groupingSpecifierError(message: string, failureReason: string): SafeBridgeError {
  return new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    message,
    {
      details: {
        failedStage: "group.specifier",
        argumentForm: "page-item-range-indices",
        failureReason,
      },
    },
  );
}

function persistGroupingTargetIdentities(
  document: unknown,
  targets: readonly unknown[],
  identity: IdentityRegistry,
  markMutation: MarkMutation,
): InDesignObjectRef[] {
  const references: InDesignObjectRef[] = [];
  for (const target of targets) {
    let reference = identity.objectRef(document, target);
    if (reference.persistentUuid === undefined) {
      markMutation();
      reference = identity.objectRef(document, target, true);
    }
    references.push(reference);
  }
  return references;
}

function assertCreatedGroup(
  document: unknown,
  group: unknown,
  expectedMembers: readonly InDesignObjectRef[],
  identity: IdentityRegistry,
): readonly GroupedMember[] {
  if (!isValid(group) || identity.kindOf(group, document) !== "group") {
    throw new SafeBridgeError(
      "UXP_OPERATION_FAILED",
      "InDesign did not return a valid group.",
      { details: { failedStage: "group.result", failureReason: "group-result-invalid" } },
    );
  }
  const pageItems = getMember(group, "pageItems");
  const childCount = collectionLength(pageItems);
  if (childCount === undefined || childCount > 100) {
    throw new SafeBridgeError(
      "UXP_OPERATION_FAILED",
      "InDesign did not expose bounded direct group membership.",
      { details: { failedStage: "group.membership", failureReason: "member-count-unavailable" } },
    );
  }
  const resolvedMembers = collectionItems(pageItems, 101);
  if (resolvedMembers.length !== childCount) {
    throw new SafeBridgeError(
      "UXP_OPERATION_FAILED",
      "InDesign did not resolve every direct group member.",
      { details: { failedStage: "group.membership", failureReason: "member-resolution-incomplete" } },
    );
  }
  const actualMembers = resolvedMembers.map((target): GroupedMember => {
    const item = identity.typedProxy(document, target);
    return { item, reference: identity.objectRef(document, item) };
  });
  const expectedPersistent = new Set(expectedMembers.flatMap((reference) => (
    reference.persistentUuid === undefined ? [] : [reference.persistentUuid]
  )));
  const actualPersistent = new Set(actualMembers.flatMap(({ reference }) => (
    reference.persistentUuid === undefined ? [] : [reference.persistentUuid]
  )));
  const persistentIdentityMatches = expectedPersistent.size === expectedMembers.length
    && actualPersistent.size === actualMembers.length
    && setsEqual(expectedPersistent, actualPersistent);
  const expectedKindsByNativeId = new Map(expectedMembers.map((reference) => [reference.nativeId, reference.kind]));
  const expectedNativeIds = new Set(expectedKindsByNativeId.keys());
  const actualNativeIds = new Set(actualMembers.map(({ reference }) => reference.nativeId));
  const nativeIdentityMatches = setsEqual(expectedNativeIds, actualNativeIds)
    && actualMembers.every(({ reference }) => {
      const expectedKind = expectedKindsByNativeId.get(reference.nativeId);
      return expectedKind !== undefined && (reference.kind === expectedKind || reference.kind === "unknown");
    });
  if (
    childCount !== expectedMembers.length
    || (!persistentIdentityMatches && !nativeIdentityMatches)
  ) {
    throw new SafeBridgeError(
      "UXP_OPERATION_FAILED",
      "InDesign returned a group with unexpected direct membership.",
      { details: { failedStage: "group.membership", failureReason: "member-identity-mismatch" } },
    );
  }
  return actualMembers;
}

function reconcileGroupedTargetAliases(
  targets: readonly ObjectTarget[],
  expectedMembers: readonly InDesignObjectRef[],
  groupedMembers: readonly GroupedMember[],
  aliases: Map<string, AliasValue>,
): void {
  const claimedMembers = new Set<number>();
  for (const [targetIndex, target] of targets.entries()) {
    if (!("ref" in target)) continue;
    const expected = expectedMembers[targetIndex];
    if (expected === undefined) throw groupedAliasError();
    const memberIndex = groupedMembers.findIndex(({ reference }, index) => (
      !claimedMembers.has(index) && sameGroupedMemberIdentity(expected, reference)
    ));
    const member = groupedMembers[memberIndex];
    if (memberIndex < 0 || member === undefined) throw groupedAliasError();
    claimedMembers.add(memberIndex);
    aliases.set(target.ref, member.item);
  }
}

function sameGroupedMemberIdentity(expected: InDesignObjectRef, actual: InDesignObjectRef): boolean {
  if (expected.persistentUuid !== undefined && actual.persistentUuid !== undefined) {
    return expected.persistentUuid === actual.persistentUuid;
  }
  return expected.nativeId === actual.nativeId
    && (actual.kind === expected.kind || actual.kind === "unknown");
}

function groupedAliasError(): SafeBridgeError {
  return new SafeBridgeError(
    "UXP_OPERATION_FAILED",
    "InDesign did not expose a final reference for every grouped alias.",
    { details: { failedStage: "group.aliases", failureReason: "grouped-alias-unresolved" } },
  );
}

function refreshProgressAliases(
  document: unknown,
  aliases: ReadonlyMap<string, AliasValue>,
  identity: IdentityRegistry,
  progress: ExecutionProgress,
): void {
  const refreshed: Record<string, InDesignObjectRef> = {};
  for (const [alias, value] of aliases) {
    refreshed[alias] = identity.objectRef(document, requireReal(value), true);
  }
  progress.aliases = refreshed;
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function stableObjectKey(document: unknown, value: unknown, identity: IdentityRegistry): string {
  const reference = identity.objectRef(document, value);
  return `${reference.kind}:${reference.nativeId}`;
}

function safeFailureMetadata(error: unknown): Record<string, string> {
  if (!(error instanceof SafeBridgeError)) return {};
  const output: Record<string, string> = {};
  for (const key of ["failedStage", "argumentForm", "failureReason"] as const) {
    const value = error.details?.[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 100 && /^[a-z0-9.-]+$/u.test(value)) {
      output[key] = value;
    }
  }
  return output;
}

function findNamed(owner: unknown, collectionName: string, name: string): unknown {
  const collection = getMember(owner, collectionName);
  if (collection === undefined) throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `InDesign does not expose ${collectionName}.`);
  if (hasMethod(collection, "itemByName")) {
    try {
      const item = callMember(collection, "itemByName", [name]);
      if (isValid(item)) return item;
    } catch {
      // Fall through to a typed collection scan.
    }
  }
  return collectionItems(collection).find((item) => getMember(item, "name") === name);
}

function validateFont(document: unknown, family: string, style: string | undefined): void {
  const application = getMember(document, "parent");
  const fonts = getMember(application, "fonts");
  if (fonts === undefined) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "This runtime does not expose the application font collection for dry-run validation.");
  }
  const requested = style === undefined ? family : `${family}\t${style}`;
  const found = findNamed(application, "fonts", requested) ?? collectionItems(fonts, 20_000).find((font) => {
    const fontFamily = safeResourceText(getMember(font, "fontFamily") ?? getMember(font, "family"));
    const fontStyle = safeResourceText(getMember(font, "fontStyleName") ?? getMember(font, "styleName"));
    return fontFamily === family && (style === undefined || fontStyle === style);
  });
  if (!isValid(found)) {
    throw new SafeBridgeError("FONT_NOT_FOUND", `Font '${family}${style === undefined ? "" : ` ${style}`}' is not installed.`);
  }
}

function applyParagraphStyleProperties(
  style: unknown,
  properties: Extract<Operation, { type: "create_or_update_paragraph_style" }>["properties"],
  fillColor: unknown,
  justification: unknown,
): void {
  if (properties.fontFamily !== undefined) setMember(style, "appliedFont", properties.fontFamily);
  if (properties.fontStyle !== undefined) setMember(style, "fontStyle", properties.fontStyle);
  if (properties.pointSize !== undefined) setMember(style, "pointSize", properties.pointSize);
  if (properties.leading !== undefined) setMember(style, "leading", properties.leading);
  if (properties.fillColor !== undefined) setMember(style, "fillColor", fillColor);
  if (properties.justification !== undefined) setMember(style, "justification", justification);
  if (properties.spaceBeforePt !== undefined) setMember(style, "spaceBefore", properties.spaceBeforePt);
  if (properties.spaceAfterPt !== undefined) setMember(style, "spaceAfter", properties.spaceAfterPt);
}

function applyObjectStyleProperties(
  style: unknown,
  properties: Extract<Operation, { type: "create_or_update_object_style" }>["properties"],
  fillColor: unknown,
  strokeColor: unknown,
): void {
  if (properties.fillColor !== undefined) setMember(style, "fillColor", fillColor);
  if (properties.strokeColor !== undefined) setMember(style, "strokeColor", strokeColor);
  if (properties.strokeWeightPt !== undefined) setMember(style, "strokeWeight", properties.strokeWeightPt);
  if (properties.opacity !== undefined) setOpacity(style, properties.opacity);
}

function setOpacity(target: unknown, value: number): void {
  setDocumentedOpacity(target, value);
}

function virtual(
  kind: string,
  operationIndex: number,
  grouping: Pick<VirtualObject, "groupingContainerKey" | "groupingContainer" | "groupingLocked" | "groupingLayerLocked"> = {},
): VirtualObject {
  return { virtual: true, kind, operationIndex, ...grouping };
}

function isVirtual(value: unknown): value is VirtualObject {
  return typeof value === "object" && value !== null && getMember(value, "virtual") === true;
}

function requireReal(value: AliasValue): unknown {
  if (isVirtual(value)) throw new SafeBridgeError("UXP_OPERATION_FAILED", "A dry-run placeholder reached DOM execution.");
  return value;
}

function isValid(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return getMember(value, "isValid") !== false;
}

function safeResourceText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function resourceKindForCollection(
  collectionName: "layers" | "colors" | "paragraphStyles" | "objectStyles",
): InDesignObjectRef["kind"] {
  switch (collectionName) {
    case "layers": return "layer";
    case "colors": return "color";
    case "paragraphStyles": return "paragraph_style";
    case "objectStyles": return "object_style";
  }
}
