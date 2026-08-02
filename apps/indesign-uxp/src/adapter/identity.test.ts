import { describe, expect, it, vi } from "vitest";

vi.mock("indesign", () => ({
  AnchorPoint: { TOP_LEFT_ANCHOR: 1, BOTTOM_RIGHT_ANCHOR: 2 },
  BoundingBoxLimits: { GEOMETRIC_PATH_BOUNDS: 3 },
  CoordinateSpaces: { PAGE_COORDINATES: 4 },
}));

import { IdentityRegistry } from "./identity";
import { InMemoryDocumentRevisionStore } from "./revision-store";

const DOCUMENT_UUID_LABEL = "com.sol.indesign-mcp.document-uuid";
const OBJECT_UUID_LABEL = "com.sol.indesign-mcp.object-uuid";
const OBJECT_KIND_LABEL = "com.sol.indesign-mcp.object-kind";

interface DocumentHarness {
  readonly labels: Map<string, string>;
  readonly writes: string[];
  wrapper(): Record<string, unknown>;
}

function documentHarness(nativeId: number, persistentUuid?: string): DocumentHarness {
  const labels = new Map<string, string>();
  if (persistentUuid !== undefined) labels.set(DOCUMENT_UUID_LABEL, persistentUuid);
  const writes: string[] = [];
  return {
    labels,
    writes,
    wrapper: () => ({
      id: nativeId,
      name: `Document ${nativeId}`,
      extractLabel: (key: string): string => labels.get(key) ?? "",
      insertLabel: (key: string, value: string): void => {
        writes.push(`${key}:${value}`);
        labels.set(key, value);
      },
    }),
  };
}

describe("IdentityRegistry document proxy handling", () => {
  it("keeps read-only session identity stable across fresh wrappers without writing labels", () => {
    const registry = new IdentityRegistry();
    const harness = documentHarness(17);

    const first = registry.documentRef(harness.wrapper());
    const second = registry.documentRef(harness.wrapper());

    expect(second.documentUuid).toBe(first.documentUuid);
    expect(second.revision).toBe(1);
    expect(harness.writes).toEqual([]);
  });

  it("persists the existing session UUID once and retains revisions across fresh wrappers", () => {
    const registry = new IdentityRegistry();
    const harness = documentHarness(18);

    const session = registry.documentRef(harness.wrapper());
    const persistent = registry.documentRef(harness.wrapper(), true);
    expect(persistent.documentUuid).toBe(session.documentUuid);
    expect(harness.labels.get(DOCUMENT_UUID_LABEL)).toBe(session.documentUuid);

    expect(registry.incrementRevision(harness.wrapper())).toBe(2);
    expect(registry.documentRef(harness.wrapper()).revision).toBe(2);
    expect(harness.writes).toHaveLength(1);
  });

  it("restores the revision after a fresh registry is created for a plugin reload", () => {
    const store = new InMemoryDocumentRevisionStore();
    const persistentUuid = "12121212-1212-4212-8212-121212121212";
    const harness = documentHarness(19, persistentUuid);
    const beforeReload = new IdentityRegistry(store);

    expect(beforeReload.incrementRevision(harness.wrapper())).toBe(2);
    const afterReload = new IdentityRegistry(store);
    expect(afterReload.documentRef(harness.wrapper()).revision).toBe(2);
  });

  it("rolls a reserved revision back when execution makes no document change", () => {
    const store = new InMemoryDocumentRevisionStore();
    const persistentUuid = "13131313-1313-4313-8313-131313131313";
    const harness = documentHarness(20, persistentUuid);
    const registry = new IdentityRegistry(store);
    const reservation = registry.reserveRevision(harness.wrapper());

    registry.rollbackRevision(reservation);
    expect(new IdentityRegistry(store).documentRef(harness.wrapper()).revision).toBe(1);
  });

  it("keeps revisions independent for two native documents that share a persistent UUID", () => {
    const registry = new IdentityRegistry();
    const duplicateUuid = "66666666-6666-4666-8666-666666666666";
    const first = documentHarness(21, duplicateUuid);
    const second = documentHarness(22, duplicateUuid);

    expect(registry.incrementRevision(first.wrapper())).toBe(2);
    expect(registry.documentRef(first.wrapper()).revision).toBe(2);
    expect(registry.documentRef(second.wrapper()).revision).toBe(1);
  });

  it("resets revision state when a reused native ID presents a different persistent UUID", () => {
    const registry = new IdentityRegistry();
    const first = documentHarness(23, "77777777-7777-4777-8777-777777777777");
    const replacement = documentHarness(23, "88888888-8888-4888-8888-888888888888");

    expect(registry.incrementRevision(first.wrapper())).toBe(2);
    expect(registry.documentRef(replacement.wrapper()).revision).toBe(1);
  });

  it("resolves an explicit reference when enumeration returns a fresh proxy wrapper", () => {
    const registry = new IdentityRegistry();
    const harness = documentHarness(24, "99999999-9999-4999-8999-999999999999");
    const reference = registry.documentRef(harness.wrapper());
    const enumeratedWrapper = harness.wrapper();

    expect(registry.resolveDocument({ documents: [enumeratedWrapper] }, reference)).toBe(enumeratedWrapper);
  });

  it("does not confuse a generic PageItem proxy with a Page", () => {
    const registry = new IdentityRegistry();
    const document = documentHarness(25, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").wrapper();
    const pageItem = {
      id: 41,
      reflect: { name: "PageItem" },
      extractLabel: (): string => "",
    };

    expect(registry.objectRef(document, pageItem).kind).toBe("unknown");
  });

  it("classifies generic PageItem proxies through their typed document collection", () => {
    const registry = new IdentityRegistry();
    const rectangle = {
      id: 42,
      reflect: { name: "PageItem" },
      extractLabel: (): string => "",
    };
    const document = {
      ...documentHarness(26, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").wrapper(),
      rectangles: [rectangle],
    };

    expect(registry.objectRef(document, rectangle).kind).toBe("rectangle");
    expect(registry.typedProxy(document, { id: 42, reflect: { name: "PageItem" } })).toBe(rectangle);
  });

  it("does not trust cross-type itemByID results as typed collection membership", () => {
    const registry = new IdentityRegistry();
    const rectangle = { id: 43, reflect: { name: "PageItem" }, extractLabel: (): string => "" };
    const document = {
      ...documentHarness(27, "cccccccc-cccc-4ccc-8ccc-cccccccccccc").wrapper(),
      textFrames: {
        length: 0,
        itemByID: (): unknown => rectangle,
      },
      rectangles: [rectangle],
    };

    expect(registry.objectRef(document, rectangle).kind).toBe("rectangle");
  });

  it("resolves a typed child through a bounded nested group after plugin reload", () => {
    const objectLabels = new Map<string, string>();
    const labelMethods = {
      extractLabel: (key: string): string => objectLabels.get(key) ?? "",
      insertLabel: (key: string, value: string): void => {
        objectLabels.set(key, value);
      },
    };
    const originalRectangle = {
      id: 44,
      name: "Grouped rectangle",
      reflect: { name: "Rectangle" },
      ...labelMethods,
    };
    const harness = documentHarness(28, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const initialDocument = {
      ...harness.wrapper(),
      rectangles: [originalRectangle],
      pageItems: [originalRectangle],
    };
    const beforeReload = new IdentityRegistry();
    const reference = beforeReload.objectRef(initialDocument, originalRectangle, true);
    expect(objectLabels.get(OBJECT_UUID_LABEL)).toBe(reference.persistentUuid);
    expect(objectLabels.get(OBJECT_KIND_LABEL)).toBe("rectangle");

    const groupedProxy = {
      id: 44,
      name: "Grouped rectangle",
      reflect: { name: "PageItem" },
      ...labelMethods,
    };
    const group = {
      id: 45,
      reflect: { name: "Group" },
      pageItems: [groupedProxy],
    };
    const reloadedDocument = {
      ...harness.wrapper(),
      rectangles: [],
      pageItems: [group],
    };
    const afterReload = new IdentityRegistry();

    expect(afterReload.objectRef(reloadedDocument, groupedProxy).kind).toBe("rectangle");
    expect(afterReload.resolveObject(reloadedDocument, reference)).toBe(groupedProxy);
  });
});
