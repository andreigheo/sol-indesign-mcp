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

import type { InDesignObjectRef, Operation } from "@sol/protocol";
import { SafeBridgeError } from "../core/errors";
import { WorkspaceManager } from "../security/workspace";
import { IdentityRegistry } from "./identity";
import {
  createExecutionProgress,
  executePreparedOperations,
  prepareOperations,
} from "./operations";

describe("group_items operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes an exact numeric PageItems range and optional typed layer to Groups.add", async () => {
    const fixture = createFixture();
    const group = fixture.createGroup();
    const add = vi.fn(() => group);
    fixture.spreadOne.groups = collectionWithAdd(add);
    const operation = fixture.operation({ layer: { name: fixture.layer.name } });

    const plan = await prepareOperations(
      fixture.document,
      [operation],
      fixture.identity,
      new WorkspaceManager(),
    );
    const progress = createExecutionProgress();
    const result = executePreparedOperations(
      fixture.document,
      plan,
      fixture.identity,
      new WorkspaceManager(),
      progress,
    );

    expect(fixture.itemByRange).toHaveBeenCalledExactlyOnceWith(0, 1);
    expect(add).toHaveBeenCalledExactlyOnceWith(fixture.groupingRange, fixture.layer);
    expect(progress).toMatchObject({ mutationStarted: true, completed: 1 });
    expect(result.aliases.probeGroup).toMatchObject({ kind: "group", nativeId: 301 });
    expect(result.aliases.probeGroup?.persistentUuid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fixture.identity.objectRef(fixture.document, fixture.first).persistentUuid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fixture.identity.objectRef(fixture.document, fixture.second).persistentUuid).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("omits the optional layer argument when none was requested", async () => {
    const fixture = createFixture();
    const add = vi.fn(() => fixture.createGroup());
    fixture.spreadOne.groups = collectionWithAdd(add);
    const plan = await prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    );

    executePreparedOperations(fixture.document, plan, fixture.identity, new WorkspaceManager());

    expect(fixture.itemByRange).toHaveBeenCalledExactlyOnceWith(0, 1);
    expect(add).toHaveBeenCalledExactlyOnceWith(fixture.groupingRange);
  });

  it("uses positions in the common PageItems collection instead of typed target indices", async () => {
    const fixture = createFixture();
    const add = vi.fn(() => fixture.createGroup());
    fixture.spreadOne.groups = collectionWithAdd(add);
    const plan = await prepareOperations(
      fixture.document,
      [fixture.operation({ targets: [{ objectRef: fixture.secondRef }, { objectRef: fixture.firstRef }] })],
      fixture.identity,
      new WorkspaceManager(),
    );

    executePreparedOperations(fixture.document, plan, fixture.identity, new WorkspaceManager());

    expect(fixture.first.index).toBe(0);
    expect(fixture.second.index).toBe(0);
    expect(fixture.itemByRange).toHaveBeenCalledExactlyOnceWith(0, 1);
    expect(add).toHaveBeenCalledExactlyOnceWith(fixture.groupingRange);
  });

  it("verifies membership from identities captured before Groups.add invalidates the original proxies", async () => {
    const fixture = createFixture();
    const groupedFirst = { ...fixture.first };
    const groupedSecond = { ...fixture.second };
    const group = fixture.createGroup([groupedFirst, groupedSecond]);
    const add = vi.fn(() => {
      fixture.first.id = -1;
      fixture.second.id = -1;
      return group;
    });
    fixture.spreadOne.groups = collectionWithAdd(add);
    const plan = await prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    );

    const result = executePreparedOperations(
      fixture.document,
      plan,
      fixture.identity,
      new WorkspaceManager(),
    );

    expect(add).toHaveBeenCalledExactlyOnceWith(fixture.groupingRange);
    expect(result.aliases.probeGroup).toMatchObject({ kind: "group", nativeId: 301 });
  });

  it("accepts exact membership through either persistent UUIDs or compatible native identities", async () => {
    const nativeOnly = createFixture();
    const nativeOnlyGroup = nativeOnly.createGroup([
      { ...nativeOnly.first, extractLabel: (): string => "" },
      { ...nativeOnly.second, extractLabel: (): string => "" },
    ]);
    nativeOnly.spreadOne.groups = collectionWithAdd(vi.fn(() => nativeOnlyGroup));
    const nativeOnlyPlan = await prepareOperations(
      nativeOnly.document,
      [nativeOnly.operation()],
      nativeOnly.identity,
      new WorkspaceManager(),
    );
    expect(executePreparedOperations(
      nativeOnly.document,
      nativeOnlyPlan,
      nativeOnly.identity,
      new WorkspaceManager(),
    ).completed).toBe(1);

    const persistentOnly = createFixture();
    const persistentOnlyGroup = persistentOnly.createGroup([
      { ...persistentOnly.first, id: 1_001 },
      { ...persistentOnly.second, id: 1_002 },
    ]);
    persistentOnly.spreadOne.groups = collectionWithAdd(vi.fn(() => persistentOnlyGroup));
    const persistentOnlyPlan = await prepareOperations(
      persistentOnly.document,
      [persistentOnly.operation()],
      persistentOnly.identity,
      new WorkspaceManager(),
    );
    expect(executePreparedOperations(
      persistentOnly.document,
      persistentOnlyPlan,
      persistentOnly.identity,
      new WorkspaceManager(),
    ).completed).toBe(1);
  });

  it("reconciles grouped aliases to their final proxies and keeps them targetable", async () => {
    const fixture = createFixture();
    const groupedFirst: Record<string, unknown> = { ...fixture.first, id: 1_001 };
    const groupedSecond: Record<string, unknown> = { ...fixture.second, id: 1_002 };
    fixture.spreadOne.groups = collectionWithAdd(vi.fn(() => fixture.createGroup([
      groupedFirst,
      groupedSecond,
    ])));
    const operations: Operation[] = [
      {
        type: "move_item_to_layer",
        ref: "firstAlias",
        target: { objectRef: fixture.firstRef },
        layer: { name: fixture.layer.name },
      },
      {
        type: "move_item_to_layer",
        ref: "secondAlias",
        target: { objectRef: fixture.secondRef },
        layer: { name: fixture.layer.name },
      },
      fixture.operation({
        targets: [{ ref: "firstAlias" }, { ref: "secondAlias" }],
      }),
      {
        type: "move_item_to_layer",
        ref: "movedAgain",
        target: { ref: "firstAlias" },
        layer: { name: fixture.layer.name },
      },
    ];
    const plan = await prepareOperations(
      fixture.document,
      operations,
      fixture.identity,
      new WorkspaceManager(),
    );

    const result = executePreparedOperations(
      fixture.document,
      plan,
      fixture.identity,
      new WorkspaceManager(),
    );

    expect(result.completed).toBe(4);
    expect(result.aliases.firstAlias).toMatchObject({ kind: "rectangle", nativeId: 1_001 });
    expect(result.aliases.secondAlias).toMatchObject({ kind: "oval", nativeId: 1_002 });
    expect(result.aliases.movedAgain).toMatchObject({ kind: "rectangle", nativeId: 1_001 });
    expect(groupedFirst.itemLayer).toBe(fixture.layer);
  });

  it("rejects targets that are not contiguous in the common PageItems collection", async () => {
    const fixture = createFixture();
    const unrelated = {
      ...domObject(103, "Unrelated Text", "TextFrame"),
      index: 0,
      parent: fixture.spreadOne,
      parentPage: fixture.pageOne,
      itemLayer: fixture.layer,
      locked: false,
    };
    fixture.spreadOne.pageItems = {
      length: 3,
      0: fixture.first,
      1: unrelated,
      2: fixture.second,
      itemByRange: fixture.itemByRange,
    };
    const add = vi.fn();
    fixture.spreadOne.groups = collectionWithAdd(add);
    const plan = await prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    );

    expect(() => executePreparedOperations(
      fixture.document,
      plan,
      fixture.identity,
      new WorkspaceManager(),
    )).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        failedStage: "group.specifier",
        argumentForm: "page-item-range-indices",
        failureReason: "targets-not-contiguous",
      },
    }));
    expect(fixture.itemByRange).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("fails closed when the common PageItems collection cannot be enumerated exactly within the bound", async () => {
    const missingLength = createFixture();
    missingLength.spreadOne.pageItems = { itemByRange: missingLength.itemByRange };
    missingLength.spreadOne.groups = collectionWithAdd(vi.fn());
    const missingLengthPlan = await prepareOperations(
      missingLength.document,
      [missingLength.operation()],
      missingLength.identity,
      new WorkspaceManager(),
    );
    expect(() => executePreparedOperations(
      missingLength.document,
      missingLengthPlan,
      missingLength.identity,
      new WorkspaceManager(),
    )).toThrow(expect.objectContaining({
      details: {
        failedStage: "group.specifier",
        argumentForm: "page-item-range-indices",
        failureReason: "collection-length-unavailable",
      },
    }));

    const incomplete = createFixture();
    incomplete.spreadOne.pageItems = {
      length: 2,
      0: incomplete.first,
      itemByRange: incomplete.itemByRange,
    };
    incomplete.spreadOne.groups = collectionWithAdd(vi.fn());
    const incompletePlan = await prepareOperations(
      incomplete.document,
      [incomplete.operation()],
      incomplete.identity,
      new WorkspaceManager(),
    );
    expect(() => executePreparedOperations(
      incomplete.document,
      incompletePlan,
      incomplete.identity,
      new WorkspaceManager(),
    )).toThrow(expect.objectContaining({
      details: {
        failedStage: "group.specifier",
        argumentForm: "page-item-range-indices",
        failureReason: "collection-resolution-incomplete",
      },
    }));

    const overLimit = createFixture();
    overLimit.spreadOne.pageItems = { length: 10_001, itemByRange: overLimit.itemByRange };
    overLimit.spreadOne.groups = collectionWithAdd(vi.fn());
    const overLimitPlan = await prepareOperations(
      overLimit.document,
      [overLimit.operation()],
      overLimit.identity,
      new WorkspaceManager(),
    );
    expect(() => executePreparedOperations(
      overLimit.document,
      overLimitPlan,
      overLimit.identity,
      new WorkspaceManager(),
    )).toThrow(expect.objectContaining({
      details: {
        failedStage: "group.specifier",
        argumentForm: "page-item-range-indices",
        failureReason: "collection-limit-exceeded",
      },
    }));
  });

  it("fails dry-run before mutation when Groups.add is unavailable", async () => {
    const fixture = createFixture();
    fixture.spreadOne.groups = { length: 0 };

    await expect(prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("rejects duplicate targets during validation", async () => {
    const fixture = createFixture();
    fixture.spreadOne.groups = collectionWithAdd(vi.fn());
    const duplicate = fixture.operation({
      targets: [{ objectRef: fixture.firstRef }, { objectRef: fixture.firstRef }],
    });

    await expect(prepareOperations(
      fixture.document,
      [duplicate],
      fixture.identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({ code: "INVALID_INPUT", message: "group_items targets must be unique." });
  });

  it("rejects targets from different spreads before mutation", async () => {
    const fixture = createFixture({ differentSpread: true });
    fixture.spreadOne.groups = collectionWithAdd(vi.fn());

    await expect(prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({ code: "INVALID_INPUT", message: "group_items targets must belong to the same spread or container." });
  });

  it("rejects cross-spread create aliases during dry-run before any DOM add", async () => {
    const fixture = createFixture({ differentSpread: true });
    const rectangleAdd = vi.fn();
    const ovalAdd = vi.fn();
    fixture.pageOne.rectangles = collectionWithAdd(rectangleAdd);
    fixture.pageTwo.ovals = collectionWithAdd(ovalAdd);
    fixture.spreadOne.groups = collectionWithAdd(vi.fn());
    const operations: Operation[] = [
      {
        type: "create_rectangle",
        ref: "plannedRectangle",
        page: { objectRef: fixture.pageOneRef },
        bounds: { x: 10, y: 10, width: 30, height: 20, unit: "pt" },
      },
      {
        type: "create_oval",
        ref: "plannedOval",
        page: { objectRef: fixture.pageTwoRef },
        bounds: { x: 50, y: 10, width: 30, height: 20, unit: "pt" },
      },
      {
        type: "group_items",
        ref: "plannedGroup",
        targets: [{ ref: "plannedRectangle" }, { ref: "plannedOval" }],
      },
    ];

    await expect(prepareOperations(
      fixture.document,
      operations,
      fixture.identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "group_items targets must belong to the same spread or container.",
    });
    expect(rectangleAdd).not.toHaveBeenCalled();
    expect(ovalAdd).not.toHaveBeenCalled();
  });

  it("rejects locked targets and destination layers before mutation", async () => {
    const lockedTarget = createFixture({ lockedTarget: true });
    lockedTarget.spreadOne.groups = collectionWithAdd(vi.fn());
    await expect(prepareOperations(
      lockedTarget.document,
      [lockedTarget.operation()],
      lockedTarget.identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({ code: "INVALID_INPUT", message: "group_items target is locked." });

    const lockedLayer = createFixture({ lockedLayer: true });
    lockedLayer.spreadOne.groups = collectionWithAdd(vi.fn());
    await expect(prepareOperations(
      lockedLayer.document,
      [lockedLayer.operation({ layer: { name: lockedLayer.layer.name } })],
      lockedLayer.identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({ code: "INVALID_INPUT", message: "group_items target layer is locked." });
  });

  it("honors a planned ensure_layer lock before a later grouping alias", async () => {
    const fixture = createFixture();
    fixture.spreadOne.groups = collectionWithAdd(vi.fn());
    const operations: Operation[] = [
      {
        type: "ensure_layer",
        ref: "plannedLockedLayer",
        name: fixture.layer.name,
        locked: true,
      },
      {
        type: "group_items",
        ref: "probeGroup",
        targets: [{ objectRef: fixture.firstRef }, { objectRef: fixture.secondRef }],
        layer: { ref: "plannedLockedLayer" },
      },
    ];

    await expect(prepareOperations(
      fixture.document,
      operations,
      fixture.identity,
      new WorkspaceManager(),
    )).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "group_items destination layer is locked.",
    });
    expect(fixture.layer.locked).toBe(false);
  });

  it("reports bounded partial metadata when the host rejects Groups.add", async () => {
    const fixture = createFixture();
    fixture.spreadOne.groups = collectionWithAdd(vi.fn(() => {
      throw new Error("raw host grouping detail");
    }));
    const plan = await prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    );

    let caught: unknown;
    try {
      executePreparedOperations(fixture.document, plan, fixture.identity, new WorkspaceManager());
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeBridgeError);
    expect(caught).toMatchObject({
      code: "UXP_OPERATION_FAILED",
      details: {
        completedOperationCount: 0,
        failedOperationIndex: 0,
        failedOperationType: "group_items",
        failedStage: "group.add",
        partialChanges: true,
      },
    });
    expect(JSON.stringify(caught)).not.toContain("raw host grouping detail");
  });

  it("rejects a page-item range that does not resolve to exactly the requested targets", async () => {
    const fixture = createFixture();
    const add = vi.fn();
    fixture.spreadOne.groups = collectionWithAdd(add);
    fixture.groupingRange.getElements = (): readonly unknown[] => [fixture.first];
    const plan = await prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    );

    expect(() => executePreparedOperations(
      fixture.document,
      plan,
      fixture.identity,
      new WorkspaceManager(),
    )).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        failedStage: "group.specifier",
        argumentForm: "page-item-range-indices",
        failureReason: "range-membership-mismatch",
      },
    }));
    expect(add).not.toHaveBeenCalled();
  });

  it("redacts host range errors and preserves bounded specifier metadata after earlier mutations", async () => {
    const fixture = createFixture();
    const add = vi.fn();
    fixture.spreadOne.groups = collectionWithAdd(add);
    fixture.itemByRange.mockImplementation(() => {
      throw new Error("raw host page-item range detail");
    });
    const plan = await prepareOperations(
      fixture.document,
      [fixture.operation()],
      fixture.identity,
      new WorkspaceManager(),
    );
    const progress = createExecutionProgress();
    progress.mutationStarted = true;
    progress.completed = 4;

    let caught: unknown;
    try {
      executePreparedOperations(fixture.document, plan, fixture.identity, new WorkspaceManager(), progress);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "UXP_OPERATION_FAILED",
      details: {
        completedOperationCount: 4,
        failedOperationIndex: 0,
        failedOperationType: "group_items",
        failureCode: "UNSUPPORTED_CAPABILITY",
        failedStage: "group.specifier",
        argumentForm: "page-item-range-indices",
        failureReason: "range-resolution-rejected",
        partialChanges: true,
      },
    });
    expect(JSON.stringify(caught)).not.toContain("raw host page-item range detail");
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects an invalid result or unexpected direct membership after mutation", async () => {
    const invalid = createFixture();
    invalid.spreadOne.groups = collectionWithAdd(vi.fn(() => ({ isValid: false })));
    const invalidPlan = await prepareOperations(
      invalid.document,
      [invalid.operation()],
      invalid.identity,
      new WorkspaceManager(),
    );
    expect(() => executePreparedOperations(
      invalid.document,
      invalidPlan,
      invalid.identity,
      new WorkspaceManager(),
    )).toThrow(expect.objectContaining({ code: "UXP_OPERATION_FAILED" }));

    const mismatch = createFixture();
    const group = mismatch.createGroup([mismatch.first]);
    mismatch.spreadOne.groups = collectionWithAdd(vi.fn(() => group));
    const mismatchPlan = await prepareOperations(
      mismatch.document,
      [mismatch.operation()],
      mismatch.identity,
      new WorkspaceManager(),
    );
    let caught: unknown;
    try {
      executePreparedOperations(mismatch.document, mismatchPlan, mismatch.identity, new WorkspaceManager());
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "UXP_OPERATION_FAILED",
      details: { failedStage: "group.membership", partialChanges: true },
    });
  });
});

interface FixtureOptions {
  readonly differentSpread?: boolean;
  readonly lockedTarget?: boolean;
  readonly lockedLayer?: boolean;
}

interface Fixture {
  readonly document: Record<string, unknown>;
  readonly identity: IdentityRegistry;
  readonly spreadOne: Record<string, unknown>;
  readonly first: Record<string, unknown>;
  readonly second: Record<string, unknown>;
  readonly groupingRange: Record<string, unknown>;
  readonly itemByRange: ReturnType<typeof vi.fn>;
  readonly layer: Record<string, unknown> & { readonly name: string };
  readonly pageOne: Record<string, unknown>;
  readonly pageTwo: Record<string, unknown>;
  readonly pageOneRef: InDesignObjectRef;
  readonly pageTwoRef: InDesignObjectRef;
  readonly firstRef: InDesignObjectRef;
  readonly secondRef: InDesignObjectRef;
  readonly createGroup: (children?: readonly unknown[]) => Record<string, unknown>;
  readonly operation: (overrides?: Partial<Extract<Operation, { type: "group_items" }>>) => Extract<Operation, { type: "group_items" }>;
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const identity = new IdentityRegistry();
  const spreadOne = {
    ...domObject(201, "Spread 1", "Spread"),
    groups: collectionWithAdd(vi.fn()),
    pageItems: {},
  };
  const spreadTwo = {
    ...domObject(202, "Spread 2", "Spread"),
    groups: collectionWithAdd(vi.fn()),
    pageItems: {},
  };
  const pageOne = { ...domObject(211, "1", "Page"), parent: spreadOne };
  const pageTwo = { ...domObject(212, "2", "Page"), parent: options.differentSpread === true ? spreadTwo : spreadOne };
  const layer = {
    ...domObject(221, "Probe Layer", "Layer"),
    name: "Probe Layer",
    locked: options.lockedLayer === true,
  };
  const first = {
    ...domObject(101, "Probe Rectangle", "Rectangle"),
    index: 0,
    parent: spreadOne,
    parentPage: pageOne,
    itemLayer: layer,
    locked: options.lockedTarget === true,
  };
  const second = {
    ...domObject(102, "Probe Oval", "Oval"),
    index: 0,
    parent: options.differentSpread === true ? spreadTwo : spreadOne,
    parentPage: pageTwo,
    itemLayer: layer,
    locked: false,
  };
  const groupingRange = {
    isValid: true,
    getElements: (): readonly unknown[] => [first, second],
  };
  const itemByRange = vi.fn((): unknown => groupingRange);
  spreadOne.pageItems = {
    length: 2,
    0: first,
    1: second,
    itemByRange,
  };
  spreadTwo.pageItems = {
    length: 1,
    0: second,
    itemByRange: (): unknown => ({ isValid: true, getElements: (): readonly unknown[] => [second] }),
  };
  const document = {
    ...domObject(1, "Grouping Test.indd", "Document"),
    rectangles: [first],
    ovals: [second],
    pageItems: [first, second],
    layers: [layer],
    groups: collectionWithAdd(vi.fn()),
    pages: [pageOne, pageTwo],
  };
  const firstRef = identity.objectRef(document, first);
  const secondRef = identity.objectRef(document, second);
  const pageOneRef = identity.objectRef(document, pageOne);
  const pageTwoRef = identity.objectRef(document, pageTwo);
  const createGroup = (children: readonly unknown[] = [first, second]): Record<string, unknown> => ({
    ...domObject(301, "Probe Group", "Group"),
    parentPage: pageOne,
    itemLayer: layer,
    pageItems: [...children],
  });
  const operation = (
    overrides: Partial<Extract<Operation, { type: "group_items" }>> = {},
  ): Extract<Operation, { type: "group_items" }> => ({
    type: "group_items",
    ref: "probeGroup",
    targets: [{ objectRef: firstRef }, { objectRef: secondRef }],
    ...overrides,
  });
  return {
    document,
    identity,
    spreadOne,
    first,
    second,
    groupingRange,
    itemByRange,
    layer,
    pageOne,
    pageTwo,
    pageOneRef,
    pageTwoRef,
    firstRef,
    secondRef,
    createGroup,
    operation,
  };
}

function collectionWithAdd(add: (...args: unknown[]) => unknown): Record<string, unknown> {
  return { length: 0, add };
}

function domObject(id: number, name: string, reflectName: string): Record<string, unknown> {
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
