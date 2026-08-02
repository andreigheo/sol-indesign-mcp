import * as z from "zod/v4";
import { BRIDGE_PROTOCOL, BoundedDetailsSchema, CapabilitySchema } from "./common.js";
import { BridgeErrorCodeSchema, BridgeErrorSchema } from "./errors.js";

const ProtocolSchema = z.literal(BRIDGE_PROTOCOL);
// A 32-byte value encodes to 43 unpadded base64url characters. The final
// character can only contain four significant bits; restricting it prevents
// alternate, non-canonical strings from decoding to the same bytes.
const Base64Url32Schema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const BridgeTransportKindSchema = z.enum(["websocket", "http"]);
const CapabilitiesSchema = z.record(z.string().max(100), CapabilitySchema).superRefine((value, context) => {
  if (Object.keys(value).length > 100) context.addIssue({ code: "custom", message: "Capabilities exceed 100 entries." });
});

export const BridgeHelloSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("hello"),
  supportedProtocols: z.array(z.string().min(1).max(100)).min(1).max(10),
  pluginVersion: z.string().min(1).max(100),
  inDesignVersion: z.string().min(1).max(100),
  transport: BridgeTransportKindSchema,
  capabilities: CapabilitiesSchema,
});
export type BridgeHello = z.infer<typeof BridgeHelloSchema>;

export const BridgeChallengeSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("challenge"),
  sessionId: Base64Url32Schema,
  nonce: Base64Url32Schema,
  expiresAt: z.number().int().positive(),
});
export type BridgeChallenge = z.infer<typeof BridgeChallengeSchema>;

export const BridgeAuthenticationSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("authentication"),
  sessionId: Base64Url32Schema,
  digest: Base64Url32Schema,
});
export type BridgeAuthentication = z.infer<typeof BridgeAuthenticationSchema>;

export const BridgeMethodSchema = z.enum([
  "indesign.status",
  "document.list",
  "document.snapshot",
  "document.selection",
  "document.inspectItems",
  "document.create",
  "document.applyOperations",
  "document.exportPreview",
  "document.saveCopy",
  "document.export",
  "document.preflight",
]);
export type BridgeMethod = z.infer<typeof BridgeMethodSchema>;

export const BridgeRequestSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("request"),
  id: z.uuid(),
  method: BridgeMethodSchema,
  params: z.record(z.string().max(100), z.unknown()).superRefine((value, context) => {
    if (Object.keys(value).length > 100) context.addIssue({ code: "custom", message: "Request parameters exceed 100 entries." });
  }),
  meta: z.strictObject({
    traceId: z.uuid(),
    deadlineMs: z.number().int().min(1).max(120_000),
  }),
});
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

const BridgeSuccessResponseSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("response"),
  id: z.uuid(),
  ok: z.literal(true),
  result: z.unknown(),
});

const BridgeFailureResponseSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("response"),
  id: z.uuid(),
  ok: z.literal(false),
  error: BridgeErrorSchema,
});

export const BridgeResponseSchema = z.discriminatedUnion("ok", [
  BridgeSuccessResponseSchema,
  BridgeFailureResponseSchema,
]);
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

export const BridgeEventNameSchema = z.enum([
  "authenticated",
  "heartbeat",
  "heartbeat_ack",
  "status",
  "request.cancel",
]);

export const BridgeEventSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("event"),
  event: BridgeEventNameSchema,
  traceId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  payload: BoundedDetailsSchema.optional(),
});
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

export const BridgeProtocolErrorSchema = z.strictObject({
  protocol: ProtocolSchema,
  type: z.literal("error"),
  code: BridgeErrorCodeSchema,
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  traceId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  details: BoundedDetailsSchema.optional(),
});
export type BridgeProtocolError = z.infer<typeof BridgeProtocolErrorSchema>;

export const BridgeFrameSchema = z.union([
  BridgeHelloSchema,
  BridgeChallengeSchema,
  BridgeAuthenticationSchema,
  BridgeRequestSchema,
  BridgeResponseSchema,
  BridgeEventSchema,
  BridgeProtocolErrorSchema,
]);
export type BridgeFrame = z.infer<typeof BridgeFrameSchema>;

export function encodeBridgeFrame(frame: BridgeFrame): string {
  return JSON.stringify(BridgeFrameSchema.parse(frame));
}

export function decodeBridgeFrame(value: string): BridgeFrame {
  return BridgeFrameSchema.parse(JSON.parse(value) as unknown);
}
