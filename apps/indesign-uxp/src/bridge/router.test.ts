import { describe, expect, it } from "vitest";
import { mapProtocolError } from "./router";

const TRACE_ID = "fe1de7b5-1efe-40df-9f0f-5a48d1fd7b64";

describe("UXP bridge error mapping", () => {
  it.each([
    ["FILE_NOT_FOUND", "FILE_NOT_FOUND"],
    ["FONT_NOT_FOUND", "FONT_NOT_FOUND"],
    ["STYLE_NOT_FOUND", "STYLE_NOT_FOUND"],
    ["PRESET_NOT_FOUND", "PRESET_NOT_FOUND"],
    ["PARTIAL_FAILURE", "PARTIAL_FAILURE"],
    ["DOCUMENT_MISMATCH", "DOCUMENT_MISMATCH"],
    ["UNSUPPORTED_CAPABILITY", "UNSUPPORTED_CAPABILITY"],
  ] as const)("maps %s without collapsing it to a generic DOM error", (localCode, protocolCode) => {
    expect(mapProtocolError({
      code: localCode,
      message: "Safe message",
      retryable: false,
    }, TRACE_ID)).toMatchObject({ code: protocolCode, traceId: TRACE_ID });
  });
});
