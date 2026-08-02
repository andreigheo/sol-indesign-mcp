import { describe, expect, it } from "vitest";
import { detectCapabilities } from "./capabilities";

describe("UXP capability reporting", () => {
  it("does not claim behavioral runtime probes from member presence alone", () => {
    const capabilities = detectCapabilities(
      {
        documents: [],
        doScript: (): void => undefined,
        preflightProcesses: {},
      },
      { scriptLanguage: 1, undoMode: 2 },
    );

    expect(capabilities.doScriptUndoGrouping?.status).toBe("documented");
    expect(capabilities.documentEnumeration?.status).toBe("documented");
    expect(capabilities.groupingArrays?.status).toBe("documented");
    expect(capabilities.preflight?.status).toBe("documented");
    expect(Object.values(capabilities)).not.toContainEqual(expect.objectContaining({ status: "runtimeProbed" }));
  });

  it("fails closed when a host member is absent", () => {
    const capabilities = detectCapabilities({});
    expect(capabilities.doScriptUndoGrouping?.status).toBe("unavailable");
    expect(capabilities.documentEnumeration?.status).toBe("unavailable");
    expect(capabilities.preflight?.status).toBe("unavailable");
  });

  it("uses documented numeric enum constants when a runtime enum export is absent", () => {
    const capabilities = detectCapabilities({ doScript: (): void => undefined }, { scriptLanguage: 1 });
    expect(capabilities.doScriptUndoGrouping?.status).toBe("documented");
    expect(capabilities.doScriptUndoGrouping?.reason).toContain("Adobe-documented numeric");
  });

  it("remains fail-closed when Application.doScript is unavailable", () => {
    const capabilities = detectCapabilities({});
    expect(capabilities.doScriptUndoGrouping?.reason).toBe(
      "Required runtime member is unavailable: Application.doScript.",
    );
  });

  it("reports grouping as runtime-probed only after this host session succeeds", () => {
    const documented = detectCapabilities({});
    const probed = detectCapabilities({}, { groupingArraysProbed: true });

    expect(documented.groupingArrays).toEqual({
      status: "documented",
      reason: "Adobe documents Spread.groups, Groups.add, and PageItems.itemByRange; the adapter resolves one common container and verifies the exact range and direct membership per operation.",
    });
    expect(probed.groupingArrays).toEqual({
      status: "runtimeProbed",
      reason: "The common container's Groups.add completed with an exact PageItems.itemByRange specifier and exact direct-membership verification in this host session.",
    });
  });

  it("reports one-step Undo as runtime-probed only after the bounded proof completes", () => {
    const application = { doScript: (): void => undefined };
    expect(detectCapabilities(application, { scriptLanguage: 1, undoMode: 2 }).doScriptUndoGrouping)
      .toMatchObject({ status: "documented" });
    expect(detectCapabilities(application, {
      scriptLanguage: 1,
      undoMode: 2,
      undoGroupingProbed: true,
    }).doScriptUndoGrouping).toMatchObject({ status: "runtimeProbed" });
  });
});
