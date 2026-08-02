import type { InDesignObjectRef, Operation } from "@sol/protocol";

/**
 * The installed-host one-step proof intentionally accepts one exact, synthetic
 * batch shape. It exercises multiple creations, a non-create mutation, alias
 * targeting, and grouping without touching any pre-existing page item.
 */
export function isApprovedUndoProofBatch(
  operations: readonly Operation[],
  aliases: Readonly<Record<string, InDesignObjectRef>>,
): boolean {
  if (operations.length !== 5) return false;
  const [rectangle, oval, textFrame, setText, group] = operations;
  if (
    rectangle?.type !== "create_rectangle"
    || oval?.type !== "create_oval"
    || textFrame?.type !== "create_text_frame"
    || setText?.type !== "set_text"
    || group?.type !== "group_items"
  ) return false;
  if (
    rectangle.ref === undefined
    || oval.ref === undefined
    || textFrame.ref === undefined
    || group.ref === undefined
  ) return false;
  const uniqueAliases = new Set([rectangle.ref, oval.ref, textFrame.ref, group.ref]);
  if (uniqueAliases.size !== 4) return false;
  if (!("ref" in setText.target) || setText.target.ref !== textFrame.ref) return false;
  if (group.targets.length !== 2 || !group.targets.every((target) => "ref" in target)) return false;
  const groupedAliases = new Set(group.targets.map((target) => "ref" in target ? target.ref : ""));
  if (groupedAliases.size !== 2 || !groupedAliases.has(rectangle.ref) || !groupedAliases.has(oval.ref)) return false;
  return aliases[rectangle.ref]?.kind === "rectangle"
    && aliases[oval.ref]?.kind === "oval"
    && aliases[textFrame.ref]?.kind === "text_frame"
    && aliases[group.ref]?.kind === "group";
}
