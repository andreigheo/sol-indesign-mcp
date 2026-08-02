import type { InDesignObjectKind } from "@sol/protocol";
import { SafeBridgeError } from "../core/errors";

export const PAGE_KIND = ["page"] as const satisfies readonly InDesignObjectKind[];
export const TEXT_KIND = ["text_frame", "story"] as const satisfies readonly InDesignObjectKind[];
export const PAGE_ITEM_KINDS = ["rectangle", "oval", "text_frame", "group", "graphic"] as const satisfies readonly InDesignObjectKind[];
export const PLACE_TARGET_KINDS = ["rectangle", "oval", "text_frame"] as const satisfies readonly InDesignObjectKind[];

export function assertSemanticTargetKind(
  actual: string,
  allowed: readonly InDesignObjectKind[],
  operation: string,
): void {
  if (!(allowed as readonly string[]).includes(actual)) {
    throw new SafeBridgeError(
      "INVALID_INPUT",
      `${operation} requires ${formatKinds(allowed)}; the resolved target is ${actual}.`,
    );
  }
}

function formatKinds(kinds: readonly InDesignObjectKind[]): string {
  return kinds.length === 1 ? `a ${kinds[0]} target` : `one of: ${kinds.join(", ")}`;
}
