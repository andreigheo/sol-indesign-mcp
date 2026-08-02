import { BridgeFrameSchema } from "@sol/protocol";
import type {
  BridgeAuthentication,
  BridgeChallenge,
  BridgeEvent,
  BridgeFrame,
  BridgeHello,
  BridgeProtocolError,
  BridgeRequest,
  BridgeResponse,
} from "@sol/protocol";
import { utf8ByteLength } from "@sol/security/uxp";
import { SafeBridgeError } from "../core/errors";

export type {
  BridgeAuthentication,
  BridgeChallenge,
  BridgeProtocolError,
  BridgeEvent,
  BridgeFrame,
  BridgeHello,
  BridgeRequest,
  BridgeResponse,
};

export const BRIDGE_PROTOCOL = "sol-indesign-bridge/1" as const;
export const BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function serializeBridgeFrame(frame: BridgeFrame): string {
  const serialized = JSON.stringify(frame);
  if (utf8ByteLength(serialized) > BRIDGE_MAX_FRAME_BYTES) {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The bridge frame exceeds the 8 MiB limit.");
  }
  return serialized;
}

export function parseBridgeFrame(input: string): BridgeFrame {
  if (utf8ByteLength(input) > BRIDGE_MAX_FRAME_BYTES) {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The bridge frame exceeds the 8 MiB limit.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input) as unknown;
  } catch {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The local bridge sent invalid JSON.");
  }
  const parsed = BridgeFrameSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The local bridge sent a frame that does not match protocol v1.");
  }
  return parsed.data;
}

export function isFrameType<T extends BridgeFrame["type"]>(
  frame: BridgeFrame,
  type: T,
): frame is Extract<BridgeFrame, { type: T }> {
  return frame.type === type;
}
