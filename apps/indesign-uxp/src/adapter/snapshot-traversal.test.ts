import { describe, expect, it } from "vitest";
import { collectSnapshotItems } from "./snapshot-traversal";

describe("snapshot depth traversal", () => {
  it("honors zero depth and nested depth limits", () => {
    const root: { id: number; parent?: unknown; pageItems: unknown[] } = { id: 1, pageItems: [] };
    const child: { id: number; parent: unknown; pageItems: unknown[] } = { id: 2, parent: root, pageItems: [] };
    const grandchild = { id: 3, parent: child, pageItems: [] as unknown[] };
    root.pageItems.push(child);
    child.pageItems.push(grandchild);
    const all = [root, child, grandchild];

    expect(collectSnapshotItems(all, 0, 10)).toMatchObject({ items: [], total: 3, truncated: true });
    expect(collectSnapshotItems(all, 1, 10).items).toEqual([root]);
    expect(collectSnapshotItems(all, 2, 10).items).toEqual([root, child]);
    expect(collectSnapshotItems(all, 8, 10).items).toEqual(all);
  });

  it("enforces the item bound across a hierarchy", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(collectSnapshotItems(items, 8, 2)).toMatchObject({ items: items.slice(0, 2), total: 3, truncated: true });
  });

  it("discovers grouped children that are not flattened into document.pageItems", () => {
    const nested = { id: 2, pageItems: [] as unknown[] };
    const group = { id: 1, pageItems: [nested] };
    expect(collectSnapshotItems([group], 2, 10)).toMatchObject({ items: [group, nested], total: 2, truncated: false });
  });
});
