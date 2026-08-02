import { describe, expect, it } from "vitest";
import {
  reframePageRelativeBounds,
  resolvePageDimensions,
  resolvePageRelativeBounds,
} from "./page-geometry";

describe("page-relative item geometry", () => {
  const enums = {
    pageCoordinates: "PAGE_COORDINATES",
    topLeftAnchor: "TOP_LEFT",
    bottomRightAnchor: "BOTTOM_RIGHT",
    geometricPathBounds: "GEOMETRIC_PATH_BOUNDS",
  };

  it("subtracts the current page trim origin and scopes anchors to PAGE coordinates", () => {
    const calls: unknown[][] = [];
    const page = {
      isValid: true,
      resolve: (...args: unknown[]) => {
        calls.push(args);
        return [[5, -20]];
      },
    };
    const item = {
      parentPage: page,
      resolve: (...args: unknown[]) => {
        calls.push(args);
        const location = Array.isArray(args[0]) ? args[0] : [];
        return location[0] === "TOP_LEFT" ? [[65, 40]] : [[165, 240]];
      },
    };

    expect(resolvePageRelativeBounds(item, enums)).toEqual({
      x: 60,
      y: 60,
      width: 100,
      height: 200,
      unit: "pt",
    });
    expect(calls).toEqual([
      [["TOP_LEFT", "GEOMETRIC_PATH_BOUNDS"], "PAGE_COORDINATES", false],
      [["BOTTOM_RIGHT", "GEOMETRIC_PATH_BOUNDS"], "PAGE_COORDINATES", false],
      [["TOP_LEFT", "GEOMETRIC_PATH_BOUNDS"], "PAGE_COORDINATES", false],
    ]);
  });

  it("computes page dimensions without depending on the trim origin", () => {
    const page = {
      resolve: (...args: unknown[]) => {
        const location = Array.isArray(args[0]) ? args[0] : [];
        return location[0] === "TOP_LEFT" ? [[5, -20]] : [[600, 822]];
      },
    };

    expect(resolvePageDimensions(page, enums)).toEqual({ width: 595, height: 842 });
  });

  it("uses geometric-path reframe bounds and applies one measured correction", () => {
    const calls: unknown[][] = [];
    const pageOrigin: readonly [number, number] = [5, -20];
    let rawTopLeft: readonly [number, number] = [0, 0];
    let rawBottomRight: readonly [number, number] = [0, 0];
    const page = { isValid: true, resolve: () => [[pageOrigin[0], pageOrigin[1]]] };
    const item = {
      parentPage: page,
      resolve: (...args: unknown[]) => {
        const location = Array.isArray(args[0]) ? args[0] : [];
        return location[0] === "TOP_LEFT" ? [rawTopLeft] : [rawBottomRight];
      },
      reframe: (...args: unknown[]) => {
        calls.push(args);
        const corners = Array.isArray(args[1]) ? args[1] : [];
        const first = Array.isArray(corners[0]) ? corners[0] : [];
        const second = Array.isArray(corners[1]) ? corners[1] : [];
        rawTopLeft = [Number(first[0]) + pageOrigin[0] + 5, Number(first[1]) + pageOrigin[1] + 5];
        rawBottomRight = [Number(second[0]) + pageOrigin[0] + 5, Number(second[1]) + pageOrigin[1] + 5];
      },
    };

    reframePageRelativeBounds(item, { x: 10, y: 20, width: 30, height: 40, unit: "pt" }, enums);

    expect(calls).toEqual([
      [["PAGE_COORDINATES", "GEOMETRIC_PATH_BOUNDS"], [[10, 20], [40, 60]]],
      [["PAGE_COORDINATES", "GEOMETRIC_PATH_BOUNDS"], [[5, 15], [35, 55]]],
    ]);
    expect(resolvePageRelativeBounds(item, enums)).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      unit: "pt",
    });
  });

  it("fails closed when the bounded correction does not converge", () => {
    let attempts = 0;
    let rawTopLeft: readonly [number, number] = [0, 0];
    let rawBottomRight: readonly [number, number] = [0, 0];
    const page = { isValid: true, resolve: () => [[0, 0]] };
    const item = {
      parentPage: page,
      resolve: (...args: unknown[]) => {
        const location = Array.isArray(args[0]) ? args[0] : [];
        return location[0] === "TOP_LEFT" ? [rawTopLeft] : [rawBottomRight];
      },
      reframe: (...args: unknown[]) => {
        attempts += 1;
        const corners = Array.isArray(args[1]) ? args[1] : [];
        const first = Array.isArray(corners[0]) ? corners[0] : [];
        const second = Array.isArray(corners[1]) ? corners[1] : [];
        const residual = attempts === 1 ? 5 : 4;
        rawTopLeft = [Number(first[0]) + residual, Number(first[1]) + residual];
        rawBottomRight = [Number(second[0]) + residual, Number(second[1]) + residual];
      },
    };

    expect(() => reframePageRelativeBounds(
      item,
      { x: 10, y: 20, width: 30, height: 40, unit: "pt" },
      enums,
    )).toThrow("could not apply exact page-relative geometric bounds");
    expect(attempts).toBe(2);
  });

  it("converts public non-point units before round-trip comparison", () => {
    const calls: unknown[][] = [];
    let rawTopLeft: readonly [number, number] = [0, 0];
    let rawBottomRight: readonly [number, number] = [0, 0];
    const page = { isValid: true, resolve: () => [[0, 0]] };
    const item = {
      parentPage: page,
      resolve: (...args: unknown[]) => {
        const location = Array.isArray(args[0]) ? args[0] : [];
        return location[0] === "TOP_LEFT" ? [rawTopLeft] : [rawBottomRight];
      },
      reframe: (...args: unknown[]) => {
        calls.push(args);
        const corners = Array.isArray(args[1]) ? args[1] : [];
        const first = Array.isArray(corners[0]) ? corners[0] : [];
        const second = Array.isArray(corners[1]) ? corners[1] : [];
        rawTopLeft = [Number(first[0]), Number(first[1])];
        rawBottomRight = [Number(second[0]), Number(second[1])];
      },
    };

    reframePageRelativeBounds(item, { x: 1, y: 1, width: 2, height: 1, unit: "in" }, enums);

    expect(calls).toEqual([
      [["PAGE_COORDINATES", "GEOMETRIC_PATH_BOUNDS"], [[72, 72], [216, 144]]],
    ]);
    expect(resolvePageRelativeBounds(item, enums)).toEqual({
      x: 72,
      y: 72,
      width: 144,
      height: 72,
      unit: "pt",
    });
  });
});
