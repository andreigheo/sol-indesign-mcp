const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export type OperationPlanningErrorCode =
  | "INVALID_ALIAS"
  | "DUPLICATE_ALIAS"
  | "UNKNOWN_ALIAS"
  | "FORWARD_ALIAS"
  | "ALIAS_NOT_SUPPORTED";

export class OperationPlanningError extends Error {
  readonly code: OperationPlanningErrorCode;
  readonly operationIndex: number;
  readonly alias: string;

  constructor(
    code: OperationPlanningErrorCode,
    message: string,
    operationIndex: number,
    alias: string,
  ) {
    super(message);
    this.name = "OperationPlanningError";
    this.code = code;
    this.operationIndex = operationIndex;
    this.alias = alias;
  }
}

export interface OperationAliasDescriptor {
  readonly producesAlias?: string;
  readonly consumesAliases?: readonly string[];
  readonly aliasSupported?: boolean;
}

export interface PlannedOperation<TOperation> {
  readonly index: number;
  readonly operation: TOperation;
  readonly producedAlias: string | null;
  readonly consumedAliases: readonly string[];
  readonly availableAliasesBefore: readonly string[];
}

export interface OperationPlan<TOperation> {
  readonly steps: readonly PlannedOperation<TOperation>[];
  readonly aliasDeclarationIndexes: ReadonlyMap<string, number>;
}

export function assertValidOperationAlias(
  alias: string,
  operationIndex: number,
): void {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new OperationPlanningError(
      "INVALID_ALIAS",
      "Aliases must start with an ASCII letter and contain at most 64 letters, digits, underscores, or hyphens.",
      operationIndex,
      alias,
    );
  }
}

export function planOperationAliases<TOperation>(
  operations: readonly TOperation[],
  describe: (
    operation: TOperation,
    index: number,
  ) => OperationAliasDescriptor,
): OperationPlan<TOperation> {
  const descriptors = operations.map((operation, index) =>
    describe(operation, index),
  );
  const declarations = new Map<string, number>();

  for (const [index, descriptor] of descriptors.entries()) {
    const alias = descriptor.producesAlias;
    if (alias === undefined) {
      continue;
    }
    assertValidOperationAlias(alias, index);
    if (descriptor.aliasSupported === false) {
      throw new OperationPlanningError(
        "ALIAS_NOT_SUPPORTED",
        "This operation cannot produce an alias.",
        index,
        alias,
      );
    }
    const previous = declarations.get(alias);
    if (previous !== undefined) {
      throw new OperationPlanningError(
        "DUPLICATE_ALIAS",
        `Alias '${alias}' was already declared by operation ${previous}.`,
        index,
        alias,
      );
    }
    declarations.set(alias, index);
  }

  const available: string[] = [];
  const steps: PlannedOperation<TOperation>[] = [];
  for (const [index, operation] of operations.entries()) {
    const descriptor = descriptors[index];
    if (descriptor === undefined) {
      throw new Error("Operation descriptor invariant violated.");
    }
    const consumed = [...new Set(descriptor.consumesAliases ?? [])];
    for (const alias of consumed) {
      assertValidOperationAlias(alias, index);
      const declarationIndex = declarations.get(alias);
      if (declarationIndex === undefined) {
        throw new OperationPlanningError(
          "UNKNOWN_ALIAS",
          `Alias '${alias}' is not declared by this operation batch.`,
          index,
          alias,
        );
      }
      if (declarationIndex >= index) {
        throw new OperationPlanningError(
          "FORWARD_ALIAS",
          `Alias '${alias}' must be declared by an earlier operation.`,
          index,
          alias,
        );
      }
    }
    const produced = descriptor.producesAlias ?? null;
    steps.push({
      index,
      operation,
      producedAlias: produced,
      consumedAliases: consumed,
      availableAliasesBefore: [...available],
    });
    if (produced !== null) {
      available.push(produced);
    }
  }

  return { steps, aliasDeclarationIndexes: new Map(declarations) };
}

export type OperationTarget<TReference> =
  | { readonly kind: "object"; readonly reference: TReference }
  | { readonly kind: "alias"; readonly alias: string };

export class AliasTable<TValue> {
  readonly #values = new Map<string, TValue>();

  declare(alias: string, value: TValue): void {
    assertValidOperationAlias(alias, -1);
    if (this.#values.has(alias)) {
      throw new OperationPlanningError(
        "DUPLICATE_ALIAS",
        `Alias '${alias}' already has a value.`,
        -1,
        alias,
      );
    }
    this.#values.set(alias, value);
  }

  resolve(alias: string): TValue {
    assertValidOperationAlias(alias, -1);
    const value = this.#values.get(alias);
    if (value === undefined && !this.#values.has(alias)) {
      throw new OperationPlanningError(
        "UNKNOWN_ALIAS",
        `Alias '${alias}' has no value.`,
        -1,
        alias,
      );
    }
    return value as TValue;
  }

  resolveTarget(target: OperationTarget<TValue>): TValue {
    return target.kind === "object"
      ? target.reference
      : this.resolve(target.alias);
  }

  snapshot(): ReadonlyMap<string, TValue> {
    return new Map(this.#values);
  }
}
