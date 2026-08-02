import * as z from "zod/v4";
import {
  BoundsSchema,
  ColorValueSchema,
  DocumentRefSchema,
  ObjectTargetSchema,
  ResourceTargetSchema,
} from "./common.js";

const RefSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const OperationBaseShape = { ref: RefSchema.optional() };
const OptionalFalseSchema = z.boolean().optional().transform((value) => value ?? false);

const EnsureLayerOperationSchema = z.strictObject({
  type: z.literal("ensure_layer"),
  ...OperationBaseShape,
  name: z.string().min(1).max(255),
  visible: z.boolean().optional(),
  printable: z.boolean().optional(),
  locked: z.boolean().optional(),
});

const CreatePageOperationSchema = z.strictObject({
  type: z.literal("create_page"),
  ...OperationBaseShape,
  after: ObjectTargetSchema.optional(),
});

const CreateShapeBase = {
  ...OperationBaseShape,
  page: ObjectTargetSchema,
  layer: ResourceTargetSchema.optional(),
  bounds: BoundsSchema,
};

const CreateRectangleOperationSchema = z.strictObject({
  type: z.literal("create_rectangle"),
  ...CreateShapeBase,
});
const CreateOvalOperationSchema = z.strictObject({
  type: z.literal("create_oval"),
  ...CreateShapeBase,
});
const CreateTextFrameOperationSchema = z.strictObject({
  type: z.literal("create_text_frame"),
  ...CreateShapeBase,
  text: z.string().max(100_000).optional(),
});

const SetTextOperationSchema = z.strictObject({
  type: z.literal("set_text"),
  ...OperationBaseShape,
  target: ObjectTargetSchema,
  text: z.string().max(100_000),
});

const SetItemBoundsOperationSchema = z.strictObject({
  type: z.literal("set_item_bounds"),
  ...OperationBaseShape,
  target: ObjectTargetSchema,
  bounds: BoundsSchema,
});

const SetItemAppearanceOperationSchema = z.strictObject({
  type: z.literal("set_item_appearance"),
  ...OperationBaseShape,
  target: ObjectTargetSchema,
  fillColor: ResourceTargetSchema.optional(),
  strokeColor: ResourceTargetSchema.optional(),
  fillTint: z.number().min(0).max(100).optional(),
  strokeTint: z.number().min(0).max(100).optional(),
  strokeWeightPt: z.number().min(0).max(1_000).optional(),
  opacity: z.number().min(0).max(100).optional(),
});

const CreateOrUpdateColorOperationSchema = z.strictObject({
  type: z.literal("create_or_update_color"),
  ...OperationBaseShape,
  name: z.string().min(1).max(255),
  color: ColorValueSchema,
});

const ParagraphStylePropertiesSchema = z.strictObject({
  fontFamily: z.string().min(1).max(255).optional(),
  fontStyle: z.string().min(1).max(255).optional(),
  pointSize: z.number().positive().max(1_296).optional(),
  leading: z.number().positive().max(5_000).optional(),
  fillColor: ResourceTargetSchema.optional(),
  justification: z.enum(["left", "center", "right", "justify"]).optional(),
  spaceBeforePt: z.number().min(0).max(10_000).optional(),
  spaceAfterPt: z.number().min(0).max(10_000).optional(),
});

const CreateOrUpdateParagraphStyleOperationSchema = z.strictObject({
  type: z.literal("create_or_update_paragraph_style"),
  ...OperationBaseShape,
  name: z.string().min(1).max(255),
  properties: ParagraphStylePropertiesSchema,
});

const ApplyParagraphStyleOperationSchema = z.strictObject({
  type: z.literal("apply_paragraph_style"),
  ...OperationBaseShape,
  target: ObjectTargetSchema,
  style: ResourceTargetSchema,
  clearOverrides: OptionalFalseSchema,
});

const ObjectStylePropertiesSchema = z.strictObject({
  fillColor: ResourceTargetSchema.optional(),
  strokeColor: ResourceTargetSchema.optional(),
  strokeWeightPt: z.number().min(0).max(1_000).optional(),
  opacity: z.number().min(0).max(100).optional(),
});

const CreateOrUpdateObjectStyleOperationSchema = z.strictObject({
  type: z.literal("create_or_update_object_style"),
  ...OperationBaseShape,
  name: z.string().min(1).max(255),
  properties: ObjectStylePropertiesSchema,
});

const ApplyObjectStyleOperationSchema = z.strictObject({
  type: z.literal("apply_object_style"),
  ...OperationBaseShape,
  target: ObjectTargetSchema,
  style: ResourceTargetSchema,
  clearOverrides: OptionalFalseSchema,
});

const PlaceFileOperationSchema = z.strictObject({
  type: z.literal("place_file"),
  ...OperationBaseShape,
  target: ObjectTargetSchema,
  path: z.string().min(1).max(1_024),
});

const GroupItemsOperationSchema = z.strictObject({
  type: z.literal("group_items"),
  ...OperationBaseShape,
  targets: z.array(ObjectTargetSchema).min(2).max(100),
  layer: ResourceTargetSchema.optional(),
});

const MoveItemToLayerOperationSchema = z.strictObject({
  type: z.literal("move_item_to_layer"),
  ...OperationBaseShape,
  target: ObjectTargetSchema,
  layer: ResourceTargetSchema,
});

export const OperationSchema = z.discriminatedUnion("type", [
  EnsureLayerOperationSchema,
  CreatePageOperationSchema,
  CreateRectangleOperationSchema,
  CreateOvalOperationSchema,
  CreateTextFrameOperationSchema,
  SetTextOperationSchema,
  SetItemBoundsOperationSchema,
  SetItemAppearanceOperationSchema,
  CreateOrUpdateColorOperationSchema,
  CreateOrUpdateParagraphStyleOperationSchema,
  ApplyParagraphStyleOperationSchema,
  CreateOrUpdateObjectStyleOperationSchema,
  ApplyObjectStyleOperationSchema,
  PlaceFileOperationSchema,
  GroupItemsOperationSchema,
  MoveItemToLayerOperationSchema,
]);
export type Operation = z.infer<typeof OperationSchema>;

export const DeleteItemsInputSchema = z.strictObject({
  documentRef: DocumentRefSchema,
  expectedRevision: z.number().int().positive(),
  items: z.array(ObjectTargetSchema).min(1).max(100),
  dryRun: z.boolean().default(true),
  checkpointPath: z.string().min(1).max(1_024),
}).superRefine((value, context) => {
  if (value.documentRef.revision !== value.expectedRevision) {
    context.addIssue({
      code: "custom",
      path: ["expectedRevision"],
      message: "expectedRevision must equal documentRef.revision.",
    });
  }
  value.items.forEach((target, index) => {
    if ("objectRef" in target && target.objectRef.documentUuid !== value.documentRef.documentUuid) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "objectRef", "documentUuid"],
        message: "The reference must belong to the requested document.",
      });
    }
  });
});
