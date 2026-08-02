import type { InDesignObjectKind } from "@sol/protocol";
import { SafeBridgeError } from "../core/errors";
import { callMember, collectionLength, getMember, hasMethod, safeText } from "../core/records";

const TEXT_KINDS = new Set<InDesignObjectKind>(["text_frame", "story"]);

/** Reads at most `maximum` characters without materializing the host object's full contents. */
export function readBoundedTextSnippet(
  item: unknown,
  kind: InDesignObjectKind,
  maximum = 500,
): string {
  if (!TEXT_KINDS.has(kind)) return "";
  const characters = getMember(item, "characters");
  const length = collectionLength(characters);
  if (length === undefined || !hasMethod(characters, "itemByRange")) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "This InDesign runtime cannot read a bounded text range safely.",
    );
  }
  if (length === 0) return "";
  const range = callMember(characters, "itemByRange", [0, Math.min(length, maximum) - 1]);
  const contents = getMember(range, "contents");
  const direct = boundedContents(contents, maximum);
  if (direct !== undefined) return direct;
  if (hasMethod(range, "getElements")) {
    const elements = callMember(range, "getElements");
    if (Array.isArray(elements)) {
      const elementContents = boundedContents(
        elements.slice(0, maximum).map((element) => getMember(element, "contents")),
        maximum,
      );
      if (elementContents !== undefined) return elementContents;
    }
  }
  throw new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    "InDesign did not return bounded text-range contents.",
  );
}

function boundedContents(value: unknown, maximum: number): string | undefined {
  if (typeof value === "string" || typeof value === "number") return safeText(value, "", maximum);
  if (!Array.isArray(value)) return undefined;
  let output = "";
  for (const part of value.slice(0, maximum)) {
    if (typeof part !== "string" && typeof part !== "number") return undefined;
    output += String(part);
    if (output.length >= maximum) break;
  }
  return safeText(output, "", maximum);
}
