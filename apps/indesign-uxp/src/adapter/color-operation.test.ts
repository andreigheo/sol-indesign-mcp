import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("indesign", () => ({
  AnchorPoint: {},
  BoundingBoxLimits: {},
  ColorModel: {},
  ColorSpace: {},
  CoordinateSpaces: {},
  Justification: {},
  LocationOptions: {},
}));

vi.mock("uxp", () => ({
  storage: {
    formats: {},
    localFileSystem: {},
  },
}));

import type { Operation } from "@sol/protocol";
import { WorkspaceManager } from "../security/workspace";
import { SafeBridgeError } from "../core/errors";
import { IdentityRegistry } from "./identity";
import {
  createExecutionProgress,
  executePreparedOperations,
  prepareOperations,
} from "./operations";

const PROCESS = 1_886_548_851;
const RGB = 1_666_336_578;
const CMYK = 1_129_142_603;

describe("atomic color operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a CMYK color with one closed add property object and documented enum fallbacks", async () => {
    const color = immutableColor(501, "Sol Cyan");
    const add = vi.fn(() => color);
    const document = testDocument({ length: 0, add, itemByName: invalidItem });
    const operation = colorOperation("Sol Cyan", { space: "CMYK", values: [100, 0, 0, 0] });
    const identity = new IdentityRegistry();
    const workspace = new WorkspaceManager();

    const plan = await prepareOperations(document, [operation], identity, workspace);
    const progress = createExecutionProgress();
    const result = executePreparedOperations(document, plan, identity, workspace, progress);

    expect(add).toHaveBeenCalledExactlyOnceWith({
      name: "Sol Cyan",
      model: PROCESS,
      space: CMYK,
      colorValue: [100, 0, 0, 0],
    });
    expect(progress).toMatchObject({ mutationStarted: true, completed: 1 });
    expect(result.aliases.brand).toMatchObject({ kind: "color", name: "Sol Cyan" });
    expect(result.aliases.brand?.persistentUuid).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("updates an existing RGB color through one properties assignment without add or sequential setters", async () => {
    const propertyAssignments: unknown[] = [];
    const color = immutableColor(502, "Sol RGB");
    Object.defineProperty(color, "properties", {
      configurable: true,
      set: (value: unknown) => propertyAssignments.push(value),
    });
    const add = vi.fn();
    const document = testDocument({ length: 1, 0: color, add, itemByName: () => color });
    const operation = colorOperation("Sol RGB", { space: "RGB", values: [10, 20, 30] });
    const identity = new IdentityRegistry();
    const workspace = new WorkspaceManager();

    const plan = await prepareOperations(document, [operation], identity, workspace);
    executePreparedOperations(document, plan, identity, workspace);

    expect(add).not.toHaveBeenCalled();
    expect(propertyAssignments).toEqual([{
      name: "Sol RGB",
      model: PROCESS,
      space: RGB,
      colorValue: [10, 20, 30],
    }]);
  });

  it("fails dry-run before mutation when colors.add is unavailable", async () => {
    const document = testDocument({ length: 0, itemByName: invalidItem });
    const identity = new IdentityRegistry();

    await expect(prepareOperations(
      document,
      [colorOperation("Sol Cyan", { space: "CMYK", values: [100, 0, 0, 0] })],
      identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("reports only bounded stage metadata when the host rejects atomic color creation", async () => {
    const add = vi.fn(() => {
      throw new Error("raw host detail must not cross the bridge");
    });
    const document = testDocument({ length: 0, add, itemByName: invalidItem });
    const identity = new IdentityRegistry();
    const workspace = new WorkspaceManager();
    const plan = await prepareOperations(
      document,
      [colorOperation("Sol Cyan", { space: "CMYK", values: [100, 0, 0, 0] })],
      identity,
      workspace,
    );

    let caught: unknown;
    try {
      executePreparedOperations(document, plan, identity, workspace);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeBridgeError);
    expect(caught).toMatchObject({
      code: "UXP_OPERATION_FAILED",
      details: {
        completedOperationCount: 0,
        failedOperationIndex: 0,
        failedOperationType: "create_or_update_color",
        failureCode: "UXP_OPERATION_FAILED",
        failedStage: "color.add",
        partialChanges: true,
      },
    });
    expect(JSON.stringify(caught)).not.toContain("raw host detail");
  });
});

type ColorOperation = Extract<Operation, { type: "create_or_update_color" }>;

function colorOperation(
  name: string,
  color: ColorOperation["color"],
): ColorOperation {
  return { type: "create_or_update_color", ref: "brand", name, color };
}

function immutableColor(id: number, name: string): Record<string, unknown> {
  const color = labeledObject(id, name, "Color");
  for (const key of ["name", "model", "space", "colorValue"] as const) {
    const value = key === "name" ? name : undefined;
    Object.defineProperty(color, key, {
      configurable: true,
      get: () => value,
      set: () => {
        throw new Error(`unexpected sequential ${key} setter`);
      },
    });
  }
  return color;
}

function testDocument(colors: Record<string, unknown>): Record<string, unknown> {
  const document = labeledObject(101, "Color Test.indd", "Document");
  document.colors = colors;
  return document;
}

function labeledObject(id: number, name: string, reflectName: string): Record<string, unknown> {
  const labels = new Map<string, string>();
  return {
    id,
    name,
    isValid: true,
    reflect: { name: reflectName },
    extractLabel: (key: string): string => labels.get(key) ?? "",
    insertLabel: (key: string, value: string): void => {
      labels.set(key, value);
    },
  };
}

function invalidItem(): { readonly isValid: false } {
  return { isValid: false };
}
