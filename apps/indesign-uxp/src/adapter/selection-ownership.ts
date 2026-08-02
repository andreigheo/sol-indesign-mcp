import { getMember } from "../core/records";

export function belongsToDocument(item: unknown, document: unknown): boolean {
  let current = item;
  for (let depth = 0; depth < 32 && current !== undefined && current !== null; depth += 1) {
    if (current === document) return true;
    current = getMember(current, "parent");
  }
  return false;
}
