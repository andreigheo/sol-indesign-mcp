export interface PreferenceField {
  readonly name: string;
  readonly read: () => unknown;
  readonly restore: (value: unknown) => void | Promise<void>;
}

export class PreferenceSnapshotError extends Error {
  readonly fieldName: string;
  override readonly cause: unknown;

  constructor(fieldName: string, cause: unknown) {
    super(`Unable to snapshot preference field: ${fieldName}.`);
    this.name = "PreferenceSnapshotError";
    this.fieldName = fieldName;
    this.cause = cause;
  }
}

export interface PreferenceRestorationFailure {
  readonly fieldName: string;
  readonly cause: unknown;
}

export class PreferenceRestoreError extends Error {
  readonly operationError: unknown;
  readonly restorationFailures: readonly PreferenceRestorationFailure[];

  constructor(
    operationError: unknown,
    restorationFailures: readonly PreferenceRestorationFailure[],
  ) {
    super(
      `Failed to restore ${restorationFailures.length} preference field(s).`,
    );
    this.name = "PreferenceRestoreError";
    this.operationError = operationError;
    this.restorationFailures = restorationFailures;
  }
}

export function preferenceField<TTarget extends object>(
  target: TTarget,
  key: keyof TTarget,
  name = String(key),
): PreferenceField {
  return {
    name,
    read: () => target[key],
    restore: (value) => {
      target[key] = value as TTarget[keyof TTarget];
    },
  };
}

export async function withPreferenceGuard<TResult>(
  fields: readonly PreferenceField[],
  operation: () => TResult | Promise<TResult>,
): Promise<TResult> {
  const snapshots: {
    readonly field: PreferenceField;
    readonly value: unknown;
  }[] = [];

  for (const field of fields) {
    try {
      snapshots.push({ field, value: field.read() });
    } catch (error: unknown) {
      throw new PreferenceSnapshotError(field.name, error);
    }
  }

  let operationError: unknown;
  let result: TResult | undefined;
  let succeeded = false;
  try {
    result = await operation();
    succeeded = true;
  } catch (error: unknown) {
    operationError = error;
  }

  const restorationFailures: PreferenceRestorationFailure[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      await snapshot.field.restore(snapshot.value);
    } catch (error: unknown) {
      restorationFailures.push({
        fieldName: snapshot.field.name,
        cause: error,
      });
    }
  }

  if (restorationFailures.length > 0) {
    throw new PreferenceRestoreError(operationError, restorationFailures);
  }
  if (!succeeded) {
    throw operationError;
  }
  return result as TResult;
}
