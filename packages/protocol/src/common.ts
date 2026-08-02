import * as z from "zod/v4";

export const BRIDGE_PROTOCOL = "sol-indesign-bridge/1" as const;
export const MAX_BRIDGE_MESSAGE_BYTES = 8 * 1024 * 1024;

export type BoundedJsonValue =
  | string
  | number
  | boolean
  | null
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

function createBoundedJsonSchema(depth: number): z.ZodType<BoundedJsonValue> {
  const primitive = z.union([
    z.string().max(2_000),
    z.number(),
    z.boolean(),
    z.null(),
  ]);
  if (depth === 0) return primitive;
  const child = createBoundedJsonSchema(depth - 1);
  const record = z.record(z.string().max(100), child).superRefine((value, context) => {
    if (Object.keys(value).length > 100) context.addIssue({ code: "custom", message: "Object exceeds 100 entries." });
  });
  return z.union([primitive, z.array(child).max(100), record]);
}

export const BoundedJsonValueSchema = createBoundedJsonSchema(6);
export const BoundedDetailsSchema = z.record(z.string().max(100), BoundedJsonValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length > 50) context.addIssue({ code: "custom", message: "Details exceed 50 entries." });
});

export const UuidSchema = z.uuid();
export const UnitSchema = z.enum(["pt", "mm", "cm", "in", "px"]);
export type Unit = z.infer<typeof UnitSchema>;

export const BoundsSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  unit: UnitSchema,
});
export type Bounds = z.infer<typeof BoundsSchema>;

export const PageReferenceSchema = z.strictObject({
  documentUuid: UuidSchema,
  nativeId: z.number().int().nonnegative(),
  name: z.string().max(255).optional(),
});
export type PageReference = z.infer<typeof PageReferenceSchema>;

export const DocumentRefSchema = z.strictObject({
  documentUuid: UuidSchema,
  nativeId: z.number().int().nonnegative().optional(),
  name: z.string().min(1).max(512),
  revision: z.number().int().positive(),
  identityPersistent: z.boolean(),
});
export type DocumentRef = z.infer<typeof DocumentRefSchema>;

export const InDesignObjectKindSchema = z.enum([
  "document",
  "page",
  "spread",
  "layer",
  "rectangle",
  "oval",
  "text_frame",
  "group",
  "graphic",
  "story",
  "color",
  "paragraph_style",
  "object_style",
  "unknown",
]);
export type InDesignObjectKind = z.infer<typeof InDesignObjectKindSchema>;

export const InDesignObjectRefSchema = z.strictObject({
  documentUuid: UuidSchema,
  nativeId: z.number().int().nonnegative(),
  persistentUuid: UuidSchema.optional(),
  kind: InDesignObjectKindSchema,
  name: z.string().max(512).optional(),
  page: PageReferenceSchema.optional(),
  fingerprint: z.string().min(1).max(256).optional(),
}).superRefine((value, context) => {
  if (value.page !== undefined && value.page.documentUuid !== value.documentUuid) {
    context.addIssue({
      code: "custom",
      path: ["page", "documentUuid"],
      message: "The page reference must belong to the same document as the object reference.",
    });
  }
});
export type InDesignObjectRef = z.infer<typeof InDesignObjectRefSchema>;

export const ObjectTargetSchema = z.union([
  z.strictObject({
    objectRef: InDesignObjectRefSchema,
    expectedFingerprint: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({
    ref: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  }),
]);
export type ObjectTarget = z.infer<typeof ObjectTargetSchema>;

export const ResourceTargetSchema = z.union([
  z.strictObject({ name: z.string().min(1).max(255) }),
  z.strictObject({ objectRef: InDesignObjectRefSchema }),
  z.strictObject({
    ref: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  }),
]);
export type ResourceTarget = z.infer<typeof ResourceTargetSchema>;

const RgbChannelSchema = z.number().min(0).max(255);
const CmykChannelSchema = z.number().min(0).max(100);
const RgbValuesSchema = z.array(RgbChannelSchema).length(3).pipe(z.tuple([
  RgbChannelSchema,
  RgbChannelSchema,
  RgbChannelSchema,
]));
const CmykValuesSchema = z.array(CmykChannelSchema).length(4).pipe(z.tuple([
  CmykChannelSchema,
  CmykChannelSchema,
  CmykChannelSchema,
  CmykChannelSchema,
]));

export const ColorValueSchema = z.discriminatedUnion("space", [
  z.strictObject({
    space: z.literal("RGB"),
    values: RgbValuesSchema,
  }),
  z.strictObject({
    space: z.literal("CMYK"),
    values: CmykValuesSchema,
  }),
]);
export type ColorValue = z.infer<typeof ColorValueSchema>;

export const TruncationSchema = z.strictObject({
  truncated: z.boolean(),
  reasons: z.array(z.string().max(200)).max(20),
  returnedItems: z.number().int().nonnegative(),
  totalItems: z.number().int().nonnegative().optional(),
  byteLimit: z.number().int().positive().optional(),
});
export type Truncation = z.infer<typeof TruncationSchema>;

export const CapabilityStateSchema = z.enum(["documented", "runtimeProbed", "unavailable"]);
export const CapabilitySchema = z.strictObject({
  status: CapabilityStateSchema,
  reason: z.string().max(500).optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;
