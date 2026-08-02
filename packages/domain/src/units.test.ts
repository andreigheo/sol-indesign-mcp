import { describe, expect, it } from "vitest";

import {
  boundsToDom,
  convertBounds,
  convertUnit,
  domToBounds,
  GeometryError,
  toPoints,
} from "./units.js";

describe("unit and bounds conversion", () => {
  it("uses the locked point conversion factors", () => {
    expect(toPoints(1, "in")).toBe(72);
    expect(toPoints(25.4, "mm")).toBeCloseTo(72, 12);
    expect(toPoints(2.54, "cm")).toBeCloseTo(72, 12);
    expect(toPoints(96, "px")).toBe(72);
    expect(convertUnit(72, "pt", "in")).toBe(1);
  });

  it("maps page-relative bounds to DOM order and back", () => {
    const dom = boundsToDom({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      unit: "mm",
    });
    expect(dom).toEqual([
      toPoints(20, "mm"),
      toPoints(10, "mm"),
      toPoints(60, "mm"),
      toPoints(40, "mm"),
    ]);
    const roundTrip = domToBounds(dom, "mm");
    expect(roundTrip.x).toBeCloseTo(10, 12);
    expect(roundTrip.y).toBeCloseTo(20, 12);
    expect(roundTrip.width).toBeCloseTo(30, 12);
    expect(roundTrip.height).toBeCloseTo(40, 12);
  });

  it("converts every component without mutating the input", () => {
    const source = { x: 1, y: 2, width: 3, height: 4, unit: "in" as const };
    const converted = convertBounds(source, "pt");
    expect(converted).toEqual({
      x: 72,
      y: 144,
      width: 216,
      height: 288,
      unit: "pt",
    });
    expect(source.unit).toBe("in");
  });

  it("rejects negative sizes and inverted DOM bounds", () => {
    expect(() =>
      boundsToDom({ x: 0, y: 0, width: -1, height: 1, unit: "pt" }),
    ).toThrow(GeometryError);
    expect(() => domToBounds([10, 0, 5, 20])).toThrow(
      /bottom >= top/u,
    );
  });
});
