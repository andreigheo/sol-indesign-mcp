export type RevisionErrorCode =
  | "INVALID_REVISION"
  | "DOCUMENT_NOT_TRACKED"
  | "DOCUMENT_ALREADY_TRACKED"
  | "STALE_DOCUMENT"
  | "REVISION_OVERFLOW";

export class RevisionError extends Error {
  readonly code: RevisionErrorCode;
  readonly documentUuid: string;
  readonly expectedRevision: number | undefined;
  readonly actualRevision: number | undefined;

  constructor(
    code: RevisionErrorCode,
    message: string,
    details: {
      readonly documentUuid: string;
      readonly expectedRevision?: number;
      readonly actualRevision?: number;
    },
  ) {
    super(message);
    this.name = "RevisionError";
    this.code = code;
    this.documentUuid = details.documentUuid;
    this.expectedRevision = details.expectedRevision;
    this.actualRevision = details.actualRevision;
  }
}

function assertDocumentUuid(documentUuid: string): void {
  if (documentUuid.trim().length === 0) {
    throw new RevisionError(
      "INVALID_REVISION",
      "Document UUID must not be empty.",
      { documentUuid },
    );
  }
}

function assertRevision(revision: number, documentUuid: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RevisionError(
      "INVALID_REVISION",
      "Revision must be a positive safe integer.",
      { documentUuid, actualRevision: revision },
    );
  }
}

export function assertExpectedRevision(
  documentUuid: string,
  expectedRevision: number,
  actualRevision: number,
): void {
  assertDocumentUuid(documentUuid);
  assertRevision(expectedRevision, documentUuid);
  assertRevision(actualRevision, documentUuid);
  if (expectedRevision !== actualRevision) {
    throw new RevisionError(
      "STALE_DOCUMENT",
      `Document revision is stale (expected ${expectedRevision}, current ${actualRevision}).`,
      { documentUuid, expectedRevision, actualRevision },
    );
  }
}

export interface MutationRevisionOutcome {
  readonly documentChanged: boolean;
  readonly partialChanges?: boolean;
}

export class RevisionTracker {
  readonly #revisions = new Map<string, number>();

  register(documentUuid: string, initialRevision = 1): number {
    assertDocumentUuid(documentUuid);
    assertRevision(initialRevision, documentUuid);
    const existingRevision = this.#revisions.get(documentUuid);
    if (existingRevision !== undefined) {
      throw new RevisionError(
        "DOCUMENT_ALREADY_TRACKED",
        "Document is already being tracked.",
        { documentUuid, actualRevision: existingRevision },
      );
    }
    this.#revisions.set(documentUuid, initialRevision);
    return initialRevision;
  }

  ensure(documentUuid: string, initialRevision = 1): number {
    const existing = this.#revisions.get(documentUuid);
    return existing ?? this.register(documentUuid, initialRevision);
  }

  current(documentUuid: string): number {
    assertDocumentUuid(documentUuid);
    const revision = this.#revisions.get(documentUuid);
    if (revision === undefined) {
      throw new RevisionError(
        "DOCUMENT_NOT_TRACKED",
        "Document is not being tracked.",
        { documentUuid },
      );
    }
    return revision;
  }

  assertExpected(documentUuid: string, expectedRevision: number): number {
    const actualRevision = this.current(documentUuid);
    assertExpectedRevision(documentUuid, expectedRevision, actualRevision);
    return actualRevision;
  }

  increment(documentUuid: string): number {
    const current = this.current(documentUuid);
    if (current === Number.MAX_SAFE_INTEGER) {
      throw new RevisionError(
        "REVISION_OVERFLOW",
        "Document revision cannot be incremented safely.",
        { documentUuid, actualRevision: current },
      );
    }
    const next = current + 1;
    this.#revisions.set(documentUuid, next);
    return next;
  }

  recordMutation(
    documentUuid: string,
    outcome: MutationRevisionOutcome,
  ): number {
    const current = this.current(documentUuid);
    if (!outcome.documentChanged && outcome.partialChanges !== true) {
      return current;
    }
    return this.increment(documentUuid);
  }

  forget(documentUuid: string): boolean {
    return this.#revisions.delete(documentUuid);
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.#revisions);
  }
}
