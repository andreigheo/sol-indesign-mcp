import { fingerprint } from "@sol/domain";
import type { DocumentRef, InDesignObjectKind, InDesignObjectRef, PageReference } from "@sol/protocol";
import { AnchorPoint, BoundingBoxLimits, CoordinateSpaces } from "indesign";
import { SafeBridgeError } from "../core/errors";
import {
  callMember,
  collectionItems,
  collectionLength,
  getMember,
  hasMethod,
  nativeId,
  safeText,
} from "../core/records";
import { DocumentSessionState } from "./document-session-state";
import type { DocumentRevisionStore } from "./revision-store";
import { InMemoryDocumentRevisionStore } from "./revision-store";
import {
  DOCUMENTED_BOTTOM_RIGHT_ANCHOR,
  DOCUMENTED_GEOMETRIC_PATH_BOUNDS,
  DOCUMENTED_PAGE_COORDINATES,
  DOCUMENTED_TOP_LEFT_ANCHOR,
  resolveDocumentedHostEnum,
} from "./host-enums";
import { resolvePageRelativeBounds } from "./page-geometry";

const DOCUMENT_UUID_LABEL = "com.sol.indesign-mcp.document-uuid";
const OBJECT_UUID_LABEL = "com.sol.indesign-mcp.object-uuid";
const OBJECT_KIND_LABEL = "com.sol.indesign-mcp.object-kind";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAGE_ITEM_KINDS = new Set<InDesignObjectKind>(["rectangle", "oval", "text_frame", "group", "graphic"]);
const PERSISTABLE_OBJECT_KINDS = new Set<string>([
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
]);
const MAX_NESTED_PAGE_ITEMS = 10_000;
const MAX_NESTED_PAGE_ITEM_DEPTH = 8;
const PAGE_GEOMETRY_ENUMS = {
  pageCoordinates: resolveDocumentedHostEnum(CoordinateSpaces.PAGE_COORDINATES, DOCUMENTED_PAGE_COORDINATES),
  topLeftAnchor: resolveDocumentedHostEnum(AnchorPoint.TOP_LEFT_ANCHOR, DOCUMENTED_TOP_LEFT_ANCHOR),
  bottomRightAnchor: resolveDocumentedHostEnum(AnchorPoint.BOTTOM_RIGHT_ANCHOR, DOCUMENTED_BOTTOM_RIGHT_ANCHOR),
  geometricPathBounds: resolveDocumentedHostEnum(
    BoundingBoxLimits.GEOMETRIC_PATH_BOUNDS,
    DOCUMENTED_GEOMETRIC_PATH_BOUNDS,
  ),
};

export class IdentityRegistry {
  readonly #sessionState = new DocumentSessionState();
  readonly #revisionStore: DocumentRevisionStore;

  constructor(revisionStore: DocumentRevisionStore = new InMemoryDocumentRevisionStore()) {
    this.#revisionStore = revisionStore;
  }

  documentRef(document: unknown, persist = false): DocumentRef {
    requireObject(document, "document");
    const id = numericNativeId(getMember(document, "id"), "document");
    const storedDocumentUuid = readLabel(document, DOCUMENT_UUID_LABEL);
    let identityPersistent = UUID_PATTERN.test(storedDocumentUuid ?? "");
    const persistentDocumentUuid = identityPersistent ? storedDocumentUuid : undefined;
    const documentUuid = this.#sessionState.resolveDocumentUuid(id, persistentDocumentUuid, createUuid);
    const storedRevision = this.#revisionStore.read(documentUuid, id);
    const revision = this.#sessionState.observeRevision(id, documentUuid, storedRevision);
    if (!identityPersistent) {
      if (persist) {
        writeLabel(document, DOCUMENT_UUID_LABEL, documentUuid);
        identityPersistent = true;
      }
    }
    return {
      documentUuid,
      nativeId: id,
      name: safeText(getMember(document, "name"), "Untitled") || "Untitled",
      revision,
      identityPersistent,
    };
  }

  objectRef(document: unknown, item: unknown, persist = false): InDesignObjectRef {
    const documentRef = this.documentRef(document, persist);
    requireObject(item, "InDesign object");
    let persistentUuid = readLabel(item, OBJECT_UUID_LABEL);
    if (!UUID_PATTERN.test(persistentUuid ?? "")) {
      persistentUuid = undefined;
      if (persist) {
        persistentUuid = createUuid();
        writeLabel(item, OBJECT_UUID_LABEL, persistentUuid);
      }
    }
    const kind = this.kindOf(item, document);
    if (persist && PERSISTABLE_OBJECT_KINDS.has(kind) && readLabel(item, OBJECT_KIND_LABEL) !== kind) {
      writeLabel(item, OBJECT_KIND_LABEL, kind);
    }
    const page = pageReference(documentRef.documentUuid, getMember(item, "parentPage"));
    const name = safeText(getMember(item, "name"));
    const result: InDesignObjectRef = {
      documentUuid: documentRef.documentUuid,
      nativeId: numericNativeId(getMember(item, "id"), kind),
      kind,
      fingerprint: fingerprintObject(item, kind),
      ...(persistentUuid === undefined ? {} : { persistentUuid }),
      ...(name.length === 0 ? {} : { name }),
      ...(page === undefined ? {} : { page }),
    };
    return result;
  }

  kindOf(item: unknown, document?: unknown): InDesignObjectKind {
    const detectedKind = detectKind(item);
    if (detectedKind !== "unknown") return detectedKind;
    if (document !== undefined) {
      const collectionKind = detectKindFromTypedCollection(document, item);
      if (collectionKind !== "unknown") return collectionKind;
    }
    const persistentUuid = readLabel(item, OBJECT_UUID_LABEL);
    const persistedKind = readLabel(item, OBJECT_KIND_LABEL);
    return UUID_PATTERN.test(persistentUuid ?? "") && isPersistableObjectKind(persistedKind)
      ? persistedKind
      : "unknown";
  }

  typedProxy(document: unknown, item: unknown): unknown {
    const kind = this.kindOf(item, document);
    if (!PAGE_ITEM_KINDS.has(kind)) return item;
    const id = Number(nativeId(getMember(item, "id")));
    if (!Number.isInteger(id) || id < 0) return item;
    for (const collection of collectionsForKind(document, kind)) {
      const candidate = candidateByNativeId(collection, id);
      if (isValid(candidate) && this.kindOf(candidate, document) === kind) return candidate;
    }
    return item;
  }

  revision(document: unknown): number {
    return this.documentRef(document).revision;
  }

  assertRevision(document: unknown, expectedRevision: number): void {
    const current = this.documentRef(document).revision;
    if (current !== expectedRevision) {
      throw new SafeBridgeError("STALE_DOCUMENT", `Expected document revision ${expectedRevision}, but the current revision is ${current}.`, {
        details: { expectedRevision, currentRevision: current },
      });
    }
  }

  incrementRevision(document: unknown): number {
    const reservation = this.reserveRevision(document);
    return this.commitRevision(reservation);
  }

  persistCurrentRevision(document: unknown): number {
    const reference = this.documentRef(document);
    const nativeDocumentId = numericNativeId(getMember(document, "id"), "document");
    this.#revisionStore.write(reference.documentUuid, nativeDocumentId, reference.revision);
    return reference.revision;
  }

  reserveRevision(document: unknown): RevisionReservation {
    requireObject(document, "document");
    const nativeDocumentId = numericNativeId(getMember(document, "id"), "document");
    const reference = this.documentRef(document);
    const nextRevision = reference.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "The document revision limit has been reached.");
    }
    this.#revisionStore.write(reference.documentUuid, nativeDocumentId, nextRevision);
    return {
      nativeDocumentId,
      documentUuid: reference.documentUuid,
      previousRevision: reference.revision,
      nextRevision,
    };
  }

  commitRevision(reservation: RevisionReservation): number {
    const current = this.#sessionState.observeRevision(
      reservation.nativeDocumentId,
      reservation.documentUuid,
    );
    if (current === reservation.nextRevision) return current;
    if (current !== reservation.previousRevision) {
      throw new SafeBridgeError("UXP_OPERATION_FAILED", "The document revision changed during mutation execution.");
    }
    return this.#sessionState.setRevision(
      reservation.nativeDocumentId,
      reservation.documentUuid,
      reservation.nextRevision,
    );
  }

  rollbackRevision(reservation: RevisionReservation): void {
    this.#revisionStore.write(
      reservation.documentUuid,
      reservation.nativeDocumentId,
      reservation.previousRevision,
    );
  }

  resolveDocument(application: unknown, referenceInput: unknown): unknown {
    if (typeof referenceInput !== "object" || referenceInput === null) {
      throw new SafeBridgeError("INVALID_INPUT", "documentRef is required.");
    }
    const reference = referenceInput as Record<string, unknown>;
    const uuid = reference.documentUuid;
    const requestedNativeId = reference.nativeId;
    if (typeof uuid !== "string") throw new SafeBridgeError("INVALID_INPUT", "documentRef.documentUuid is required.");
    const matchingDocuments: { readonly document: unknown; readonly nativeId: number }[] = [];
    for (const document of collectionItems(getMember(application, "documents"), 200)) {
      const current = this.documentRef(document);
      if (current.documentUuid !== uuid) continue;
      matchingDocuments.push({ document, nativeId: current.nativeId ?? -1 });
      if (requestedNativeId !== undefined && Number(requestedNativeId) === current.nativeId) return document;
    }
    if (requestedNativeId === undefined && matchingDocuments.length === 1) {
      return matchingDocuments[0]?.document;
    }
    if (requestedNativeId === undefined && matchingDocuments.length > 1) {
      throw new SafeBridgeError(
        "DOCUMENT_MISMATCH",
        "More than one open document has this UUID; refresh the document reference and include its native ID.",
      );
    }
    if (matchingDocuments.length > 0) {
      throw new SafeBridgeError("DOCUMENT_NOT_FOUND", "The document UUID and native ID do not identify the same document.");
    }
    throw new SafeBridgeError("DOCUMENT_NOT_FOUND", "The referenced InDesign document is no longer open.", { retryable: true });
  }

  resolveObject(document: unknown, referenceInput: unknown, expectedFingerprint?: string): unknown {
    if (typeof referenceInput !== "object" || referenceInput === null) {
      throw new SafeBridgeError("INVALID_INPUT", "An object reference is required.");
    }
    const reference = referenceInput as Record<string, unknown>;
    const documentRef = this.documentRef(document);
    if (reference.documentUuid !== documentRef.documentUuid) {
      throw new SafeBridgeError("ITEM_NOT_FOUND", "The object reference belongs to a different document.");
    }
    const id = Number(reference.nativeId);
    if (!Number.isInteger(id) || id < 0) throw new SafeBridgeError("INVALID_INPUT", "Object nativeId must be a non-negative integer.");
    const kind = typeof reference.kind === "string" ? reference.kind : "unknown";
    const collections = collectionsForKind(document, kind);
    const candidates = collections.map((collection) => candidateByNativeId(collection, id));
    if (isPageItemKind(kind) || kind === "unknown") {
      candidates.push(nestedPageItemCandidateByNativeId(document, id));
    }
    for (const candidate of candidates) {
      if (!isValid(candidate)) continue;
      const current = this.objectRef(document, candidate);
      if (current.kind !== kind && kind !== "unknown") {
        throw new SafeBridgeError("ITEM_NOT_FOUND", "The object native ID now belongs to a different object kind.");
      }
      if (typeof reference.persistentUuid === "string" && current.persistentUuid !== reference.persistentUuid) {
        throw new SafeBridgeError("STALE_OBJECT", "The persistent object identity no longer matches.");
      }
      const requiredFingerprint = expectedFingerprint ?? (typeof reference.fingerprint === "string" ? reference.fingerprint : undefined);
      if (requiredFingerprint !== undefined && current.fingerprint !== requiredFingerprint) {
        throw new SafeBridgeError("STALE_OBJECT", "The object changed after it was inspected.", {
          details: { expectedFingerprint: requiredFingerprint, currentFingerprint: current.fingerprint },
        });
      }
      return candidate;
    }
    throw new SafeBridgeError("ITEM_NOT_FOUND", "The referenced InDesign object no longer exists.", { retryable: true });
  }
}

export interface RevisionReservation {
  readonly nativeDocumentId: number;
  readonly documentUuid: string;
  readonly previousRevision: number;
  readonly nextRevision: number;
}

function requireObject(value: unknown, label: string): object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `InDesign returned an invalid ${label}.`);
  }
  return value;
}

function readLabel(target: unknown, key: string): string | undefined {
  try {
    if (!hasMethod(target, "extractLabel")) return undefined;
    const value = callMember(target, "extractLabel", [key]);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeLabel(target: unknown, key: string, value: string): void {
  if (!hasMethod(target, "insertLabel")) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "This InDesign object cannot persist MCP identity labels.");
  }
  callMember(target, "insertLabel", [key, value]);
}

function createUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function numericNativeId(value: unknown, label: string): number {
  const id = Number(nativeId(value));
  if (!Number.isInteger(id) || id < 0) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `InDesign did not provide a stable native ID for the ${label}.`);
  }
  return id;
}

function detectKind(item: unknown): InDesignObjectKind {
  const names = [
    normalizeDomClassName(getMember(getMember(item, "constructor"), "name")),
    normalizeDomClassName(getMember(getMember(item, "reflect"), "name")),
  ];
  if (names.includes("textframe")) return "text_frame";
  if (names.includes("rectangle")) return "rectangle";
  if (names.includes("oval") || names.includes("ellipse")) return "oval";
  if (names.includes("paragraphstyle")) return "paragraph_style";
  if (names.includes("objectstyle")) return "object_style";
  if (names.includes("document")) return "document";
  if (names.includes("spread")) return "spread";
  if (names.includes("page")) return "page";
  if (names.includes("layer")) return "layer";
  if (names.includes("group")) return "group";
  if (names.includes("graphic") || names.includes("image")) return "graphic";
  if (names.includes("story")) return "story";
  if (names.includes("color") || names.includes("swatch")) return "color";
  return "unknown";
}

function normalizeDomClassName(value: unknown): string {
  return safeText(value).toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function detectKindFromTypedCollection(document: unknown, item: unknown): InDesignObjectKind {
  const id = Number(nativeId(getMember(item, "id")));
  if (!Number.isInteger(id) || id < 0) return "unknown";
  const typedCollections: readonly (readonly [InDesignObjectKind, string])[] = [
    ["text_frame", "textFrames"],
    ["rectangle", "rectangles"],
    ["oval", "ovals"],
    ["group", "groups"],
    ["graphic", "allGraphics"],
  ];
  for (const [kind, collectionName] of typedCollections) {
    const collection = getMember(document, collectionName);
    if (collectionContainsNativeId(collection, id)) return kind;
  }
  return "unknown";
}

function collectionContainsNativeId(collection: unknown, id: number): boolean {
  return isValid(candidateByNativeId(collection, id));
}

function nestedPageItemCandidateByNativeId(document: unknown, requestedId: number): unknown {
  const rootCollection = getMember(document, "pageItems");
  const rootLength = collectionLength(rootCollection);
  if (rootLength === undefined || rootLength > MAX_NESTED_PAGE_ITEMS) return undefined;
  const roots = collectionItems(rootCollection, rootLength);
  if (roots.length !== rootLength) return undefined;
  const queue = roots.map((item) => ({ item, depth: 0 }));
  const visitedIds = new Set<number>();
  let visitedCount = 0;
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) break;
    const id = Number(nativeId(getMember(entry.item, "id")));
    if (Number.isInteger(id) && id >= 0) {
      if (id === requestedId) return entry.item;
      if (visitedIds.has(id)) continue;
      visitedIds.add(id);
    }
    visitedCount += 1;
    if (visitedCount >= MAX_NESTED_PAGE_ITEMS || entry.depth >= MAX_NESTED_PAGE_ITEM_DEPTH) continue;
    const childCollection = getMember(entry.item, "pageItems");
    const childLength = collectionLength(childCollection);
    if (childLength === undefined || childLength === 0) continue;
    if (childLength > MAX_NESTED_PAGE_ITEMS - visitedCount - queue.length) return undefined;
    const children = collectionItems(childCollection, childLength);
    if (children.length !== childLength) return undefined;
    queue.push(...children.map((item) => ({ item, depth: entry.depth + 1 })));
  }
  return undefined;
}

function candidateByNativeId(collection: unknown, id: number): unknown {
  const length = collectionLength(collection);
  if (length === undefined || length > 10_000) return undefined;
  return collectionItems(collection, length).find((candidate) => Number(getMember(candidate, "id")) === id);
}

function isPersistableObjectKind(value: string | undefined): value is InDesignObjectKind {
  return value !== undefined && PERSISTABLE_OBJECT_KINDS.has(value);
}

function isPageItemKind(value: string): value is InDesignObjectKind {
  return value === "rectangle"
    || value === "oval"
    || value === "text_frame"
    || value === "group"
    || value === "graphic";
}

function pageReference(documentUuid: string, page: unknown): PageReference | undefined {
  if (!isValid(page)) return undefined;
  const id = Number(getMember(page, "id"));
  if (!Number.isInteger(id) || id < 0) return undefined;
  const name = safeText(getMember(page, "name"));
  return { documentUuid, nativeId: id, ...(name.length === 0 ? {} : { name }) };
}

function fingerprintObject(item: unknown, kind: InDesignObjectKind): string {
  const pageBounds = PAGE_ITEM_KINDS.has(kind) ? canonicalPageBounds(item) : [];
  return fingerprint({
    kind,
    id: Number(getMember(item, "id")),
    name: safeText(getMember(item, "name")),
    pageBounds,
    visible: getMember(item, "visible") === true,
    locked: getMember(item, "locked") === true,
  });
}

function canonicalPageBounds(item: unknown): readonly number[] {
  try {
    const bounds = resolvePageRelativeBounds(item, PAGE_GEOMETRY_ENUMS);
    return [bounds.x, bounds.y, bounds.width, bounds.height];
  } catch {
    // Never fall back to ruler-dependent geometricBounds. Unsupported hosts
    // retain the remaining stable fingerprint fields and omit geometry.
    return [];
  }
}

function collectionsForKind(document: unknown, kind: string): unknown[] {
  const mapping: Record<string, readonly string[]> = {
    page: ["pages"],
    spread: ["spreads"],
    layer: ["layers"],
    rectangle: ["rectangles", "pageItems"],
    oval: ["ovals", "pageItems"],
    text_frame: ["textFrames", "pageItems"],
    group: ["groups", "pageItems"],
    graphic: ["allGraphics", "pageItems"],
    story: ["stories"],
    color: ["colors"],
    paragraph_style: ["paragraphStyles"],
    object_style: ["objectStyles"],
    unknown: ["pageItems", "pages", "layers", "stories"],
  };
  return (mapping[kind] ?? mapping.unknown ?? []).map((name) => getMember(document, name)).filter((value) => value !== undefined);
}

function isValid(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const valid = getMember(value, "isValid");
  return valid === undefined || valid === true;
}
