import { SafeBridgeError } from "../core/errors";

const REVISION_KEY_PREFIX = "sol.indesign-mcp.document-revision.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DocumentRevisionStore {
  read(documentUuid: string, nativeId: number): number | undefined;
  write(documentUuid: string, nativeId: number, revision: number): void;
}

export class InMemoryDocumentRevisionStore implements DocumentRevisionStore {
  readonly #revisions = new Map<string, number>();

  read(documentUuid: string, nativeId: number): number | undefined {
    return this.#revisions.get(revisionKey(documentUuid, nativeId));
  }

  write(documentUuid: string, nativeId: number, revision: number): void {
    assertRevision(revision);
    this.#revisions.set(revisionKey(documentUuid, nativeId), revision);
  }
}

export class LocalStorageDocumentRevisionStore implements DocumentRevisionStore {
  readonly #storage: KeyValueStorage;

  constructor(storage: KeyValueStorage = localStorage) {
    this.#storage = storage;
  }

  read(documentUuid: string, nativeId: number): number | undefined {
    let stored: string | null;
    try {
      stored = this.#storage.getItem(revisionKey(documentUuid, nativeId));
    } catch {
      throw unavailableStore();
    }
    if (stored === null) return undefined;
    if (!/^[1-9][0-9]*$/u.test(stored)) throw corruptStore();
    const revision = Number(stored);
    if (!Number.isSafeInteger(revision) || revision < 1) throw corruptStore();
    return revision;
  }

  write(documentUuid: string, nativeId: number, revision: number): void {
    assertRevision(revision);
    try {
      this.#storage.setItem(revisionKey(documentUuid, nativeId), String(revision));
    } catch {
      throw unavailableStore();
    }
  }
}

function revisionKey(documentUuid: string, nativeId: number): string {
  if (!UUID_PATTERN.test(documentUuid) || !Number.isInteger(nativeId) || nativeId < 0) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign returned invalid document identity for revision storage.");
  }
  return `${REVISION_KEY_PREFIX}.${documentUuid}.${nativeId}`;
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "The document revision cannot be stored safely.");
  }
}

function unavailableStore(): SafeBridgeError {
  return new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    "Persistent document revision storage is unavailable; document mutation is disabled.",
  );
}

function corruptStore(): SafeBridgeError {
  return new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    "Persistent document revision state is invalid; repair the plugin data before mutating documents.",
  );
}
