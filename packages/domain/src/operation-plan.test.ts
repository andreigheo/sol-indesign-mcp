import { describe, expect, it } from "vitest";

import {
  AliasTable,
  OperationPlanningError,
  planOperationAliases,
} from "./operation-plan.js";

interface ExampleOperation {
  readonly name: string;
  readonly alias?: string;
  readonly uses?: readonly string[];
  readonly supportsAlias?: boolean;
}

function plan(operations: readonly ExampleOperation[]) {
  return planOperationAliases(operations, (operation) => ({
    ...(operation.alias === undefined
      ? {}
      : { producesAlias: operation.alias }),
    ...(operation.uses === undefined
      ? {}
      : { consumesAliases: operation.uses }),
    ...(operation.supportsAlias === undefined
      ? {}
      : { aliasSupported: operation.supportsAlias }),
  }));
}

describe("operation alias planning", () => {
  it("builds an ordered plan using only earlier aliases", () => {
    const result = plan([
      { name: "rectangle", alias: "hero" },
      { name: "text", alias: "caption" },
      { name: "group", uses: ["hero", "caption"] },
    ]);
    expect(result.steps[2]).toMatchObject({
      consumedAliases: ["hero", "caption"],
      availableAliasesBefore: ["hero", "caption"],
    });
    expect(result.aliasDeclarationIndexes.get("caption")).toBe(1);
  });

  it.each([
    {
      operations: [
        { name: "group", uses: ["later"] },
        { name: "rectangle", alias: "later" },
      ],
      code: "FORWARD_ALIAS",
    },
    {
      operations: [{ name: "group", uses: ["missing"] }],
      code: "UNKNOWN_ALIAS",
    },
    {
      operations: [
        { name: "a", alias: "same" },
        { name: "b", alias: "same" },
      ],
      code: "DUPLICATE_ALIAS",
    },
    {
      operations: [{ name: "a", alias: "bad alias" }],
      code: "INVALID_ALIAS",
    },
  ])("rejects $code plans", ({ operations, code }) => {
    try {
      plan(operations);
      throw new Error("Expected planning to fail.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OperationPlanningError);
      expect(error).toMatchObject({ code });
    }
  });

  it("supports typed virtual values for dry-run planning", () => {
    const aliases = new AliasTable<{ readonly virtualId: string }>();
    aliases.declare("hero", { virtualId: "dry-run:0" });
    expect(aliases.resolveTarget({ kind: "alias", alias: "hero" })).toEqual({
      virtualId: "dry-run:0",
    });
    expect(() => aliases.declare("hero", { virtualId: "duplicate" })).toThrow(
      /already has a value/u,
    );
  });
});
