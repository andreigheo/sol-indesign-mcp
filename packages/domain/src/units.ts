export const SUPPORTED_UNITS = ["pt", "mm", "cm", "in", "px"] as const;

export type Unit = (typeof SUPPORTED_UNITS)[number];

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly unit: Unit;
}

export type DomBounds = readonly [
  top: number,
  left: number,
  bottom: number,
  right: number,
];

const POINTS_PER_UNIT: Readonly<Record<Unit, number>> = Object.freeze({
  pt: 1,
  in: 72,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  px: 72 / 96,
});

export type GeometryErrorCode =
  | "NON_FINITE_GEOMETRY"
  | "NEGATIVE_SIZE"
  | "INVALID_DOM_BOUNDS";

export class GeometryError extends RangeError {
  readonly code: GeometryErrorCode;

  constructor(code: GeometryErrorCode, message: string) {
    super(message);
    this.name = "GeometryError";
    this.code = code;
  }
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new GeometryError(
      "NON_FINITE_GEOMETRY",
      `${field} must be a finite number.`,
    );
  }
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function toPoints(value: number, unit: Unit): number {
  assertFinite(value, "value");
  return normalizeZero(value * POINTS_PER_UNIT[unit]);
}

export function fromPoints(value: number, unit: Unit): number {
  assertFinite(value, "value");
  return normalizeZero(value / POINTS_PER_UNIT[unit]);
}

export function convertUnit(value: number, from: Unit, to: Unit): number {
  return fromPoints(toPoints(value, from), to);
}

export function assertValidBounds(bounds: Bounds): void {
  assertFinite(bounds.x, "x");
  assertFinite(bounds.y, "y");
  assertFinite(bounds.width, "width");
  assertFinite(bounds.height, "height");
  if (bounds.width < 0 || bounds.height < 0) {
    throw new GeometryError(
      "NEGATIVE_SIZE",
      "Bounds width and height must be non-negative.",
    );
  }
}

export function boundsToDom(bounds: Bounds): DomBounds {
  assertValidBounds(bounds);
  const top = toPoints(bounds.y, bounds.unit);
  const left = toPoints(bounds.x, bounds.unit);
  const bottom = top + toPoints(bounds.height, bounds.unit);
  const right = left + toPoints(bounds.width, bounds.unit);
  return [top, left, normalizeZero(bottom), normalizeZero(right)];
}

export function domToBounds(domBounds: DomBounds, unit: Unit = "pt"): Bounds {
  const [top, left, bottom, right] = domBounds;
  assertFinite(top, "top");
  assertFinite(left, "left");
  assertFinite(bottom, "bottom");
  assertFinite(right, "right");
  if (bottom < top || right < left) {
    throw new GeometryError(
      "INVALID_DOM_BOUNDS",
      "DOM bounds must have bottom >= top and right >= left.",
    );
  }
  return {
    x: fromPoints(left, unit),
    y: fromPoints(top, unit),
    width: fromPoints(right - left, unit),
    height: fromPoints(bottom - top, unit),
    unit,
  };
}

export function convertBounds(bounds: Bounds, unit: Unit): Bounds {
  assertValidBounds(bounds);
  if (bounds.unit === unit) {
    return { ...bounds };
  }
  return {
    x: convertUnit(bounds.x, bounds.unit, unit),
    y: convertUnit(bounds.y, bounds.unit, unit),
    width: convertUnit(bounds.width, bounds.unit, unit),
    height: convertUnit(bounds.height, bounds.unit, unit),
    unit,
  };
}
