import { collectionLength, getMember, nativeId } from "../core/records";

/**
 * InDesign throws while reading app.activeDocument when no document is open.
 * Check the documented documents collection first so read-only status/list
 * calls can represent that normal host state as no active document.
 */
export function activeDocumentIfPresent(application: unknown): unknown {
  const documents = getMember(application, "documents");
  if (collectionLength(documents) === 0) return undefined;
  const document = getMember(application, "activeDocument");
  if (document === undefined || document === null || getMember(document, "isValid") === false) return undefined;
  return document;
}

export function sameNativeDocument(left: unknown, right: unknown): boolean {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  if (left === right) return true;
  const leftId = nativeId(getMember(left, "id"));
  const rightId = nativeId(getMember(right, "id"));
  return leftId !== undefined && leftId === rightId;
}
