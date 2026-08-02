import { callMember } from "../core/records";

/** Adobe Documents.add(showingWindow, ...) requires true for a visible document. */
export function addVisibleDocument(documents: unknown): unknown {
  return callMember(documents, "add", [true]);
}
