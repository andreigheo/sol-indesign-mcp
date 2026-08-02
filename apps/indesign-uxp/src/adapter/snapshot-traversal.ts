import { collectionItems, getMember, nativeId } from "../core/records";

export interface SnapshotTraversal {
  items: unknown[];
  total: number;
  truncated: boolean;
}

export function collectSnapshotItems(allItems: readonly unknown[], maxDepth: number, maxItems: number): SnapshotTraversal {
  const seeds = unique(allItems);
  if (maxDepth === 0 || maxItems === 0) {
    return { items: [], total: seeds.length, truncated: seeds.length > 0 };
  }

  const seedKeys = new Set(seeds.map(itemKey));
  const childrenByParent = new Map<unknown, unknown[]>();
  const childKeys = new Set<unknown>();
  for (const item of seeds) {
    const parent = getMember(item, "parent");
    const parentKey = itemKey(parent);
    if (seedKeys.has(parentKey)) {
      addChild(childrenByParent, parentKey, item);
      childKeys.add(itemKey(item));
    }
  }

  const roots = seeds.filter((item) => !childKeys.has(itemKey(item)));
  const queue = (roots.length > 0 ? roots : seeds).map((item) => ({ item, depth: 1 }));
  const seen = new Set<unknown>();
  const known = new Set(seeds.map(itemKey));
  const result: unknown[] = [];
  let depthLimited = false;
  let itemLimited = false;
  let index = 0;
  while (index < queue.length) {
    const current = queue[index];
    index += 1;
    if (current === undefined) continue;
    const key = itemKey(current.item);
    if (seen.has(key)) continue;
    if (result.length >= maxItems) {
      itemLimited = true;
      break;
    }
    seen.add(key);
    result.push(current.item);

    const children = unique([
      ...(childrenByParent.get(key) ?? []),
      ...collectionItems(getMember(current.item, "pageItems"), maxItems + 1),
    ]);
    for (const child of children) known.add(itemKey(child));
    if (current.depth >= maxDepth) {
      if (children.length > 0) depthLimited = true;
      continue;
    }
    for (const child of children) queue.push({ item: child, depth: current.depth + 1 });
  }

  return {
    items: result,
    total: known.size,
    truncated: depthLimited || itemLimited || result.length < known.size,
  };
}

function unique(items: readonly unknown[]): unknown[] {
  const seen = new Set<unknown>();
  const output: unknown[] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function addChild(children: Map<unknown, unknown[]>, parentKey: unknown, child: unknown): void {
  const current = children.get(parentKey) ?? [];
  if (!current.some((candidate) => itemKey(candidate) === itemKey(child))) current.push(child);
  children.set(parentKey, current);
}

function itemKey(value: unknown): unknown {
  const id = nativeId(getMember(value, "id"));
  return id === undefined ? value : `id:${id}`;
}
