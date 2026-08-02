export class DocumentSessionState {
  readonly #documentUuidsByNativeId = new Map<number, string>();
  readonly #revisionsByDocumentInstance = new Map<string, number>();

  resolveDocumentUuid(
    nativeId: number,
    persistentUuid: string | undefined,
    createUuid: () => string,
  ): string {
    const documentUuid = persistentUuid ?? this.#documentUuidsByNativeId.get(nativeId) ?? createUuid();
    this.#documentUuidsByNativeId.set(nativeId, documentUuid);
    return documentUuid;
  }

  observeRevision(nativeId: number, documentUuid: string, persistedRevision?: number): number {
    const key = documentInstanceKey(nativeId, documentUuid);
    const existing = this.#revisionsByDocumentInstance.get(key);
    if (existing !== undefined) return existing;
    const revision = persistedRevision ?? 1;
    this.#revisionsByDocumentInstance.set(key, revision);
    return revision;
  }

  incrementRevision(nativeId: number, documentUuid: string): number {
    const key = documentInstanceKey(nativeId, documentUuid);
    const next = (this.#revisionsByDocumentInstance.get(key) ?? 1) + 1;
    this.#revisionsByDocumentInstance.set(key, next);
    return next;
  }

  setRevision(nativeId: number, documentUuid: string, revision: number): number {
    const key = documentInstanceKey(nativeId, documentUuid);
    this.#revisionsByDocumentInstance.set(key, revision);
    return revision;
  }
}

function documentInstanceKey(nativeId: number, documentUuid: string): string {
  return `${nativeId}:${documentUuid}`;
}
