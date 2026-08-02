import { boundsToDom } from "@sol/domain";
import type { Bounds } from "@sol/domain";
import { SafeBridgeError } from "../core/errors";
import { callMember, getMember, hasMethod } from "../core/records";

export interface PageGeometryEnums {
  readonly pageCoordinates: unknown;
  readonly topLeftAnchor: unknown;
  readonly bottomRightAnchor: unknown;
  readonly geometricPathBounds: unknown;
}

const ROUND_TRIP_EPSILON_PT = 0.01;

/** Reads geometric-path bounds in page coordinates and always interprets numbers as points. */
export function resolvePageRelativeBounds(item: unknown, enums: PageGeometryEnums): Bounds {
  assertGeometryEnums(enums);
  const { topLeft, bottomRight } = resolveRawBounds(item, enums);
  const page = getMember(item, "parentPage");
  if (page === undefined || page === null || getMember(page, "isValid") === false || !hasMethod(page, "resolve")) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "InDesign did not provide a valid parent page for page-relative geometry.",
    );
  }
  const pageTopLeft = resolvePoint(page, enums.topLeftAnchor, enums);
  const width = bottomRight[0] - topLeft[0];
  const height = bottomRight[1] - topLeft[1];
  if (width < 0 || height < 0) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign returned inverted page-relative item bounds.");
  }
  return {
    x: topLeft[0] - pageTopLeft[0],
    y: topLeft[1] - pageTopLeft[1],
    width,
    height,
    unit: "pt",
  };
}

export function resolvePageDimensions(page: unknown, enums: PageGeometryEnums): { width: number; height: number } {
  assertGeometryEnums(enums);
  const { topLeft, bottomRight } = resolveRawBounds(page, enums);
  const width = bottomRight[0] - topLeft[0];
  const height = bottomRight[1] - topLeft[1];
  if (width <= 0 || height <= 0) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign returned invalid page dimensions.");
  }
  return { width, height };
}

/** Reframes geometric-path bounds and verifies exact page-relative round-trip geometry. */
export function reframePageRelativeBounds(item: unknown, bounds: Bounds, enums: PageGeometryEnums): void {
  assertGeometryEnums(enums);
  const [top, left, bottom, right] = boundsToDom(bounds);
  const expected: Bounds = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    unit: "pt",
  };
  reframe(item, left, top, right, bottom, enums);
  const first = resolvePageRelativeBounds(item, enums);
  if (boundsMatch(first, expected)) return;

  reframe(
    item,
    left + (expected.x - first.x),
    top + (expected.y - first.y),
    right + ((expected.x + expected.width) - (first.x + first.width)),
    bottom + ((expected.y + expected.height) - (first.y + first.height)),
    enums,
  );
  const second = resolvePageRelativeBounds(item, enums);
  if (!boundsMatch(second, expected)) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "InDesign could not apply exact page-relative geometric bounds after a bounded correction.",
    );
  }
}

function reframe(
  item: unknown,
  left: number,
  top: number,
  right: number,
  bottom: number,
  enums: PageGeometryEnums,
): void {
  callMember(item, "reframe", [
    [enums.pageCoordinates, enums.geometricPathBounds],
    [[left, top], [right, bottom]],
  ]);
}

function resolveRawBounds(
  item: unknown,
  enums: PageGeometryEnums,
): { topLeft: readonly [number, number]; bottomRight: readonly [number, number] } {
  return {
    topLeft: resolvePoint(item, enums.topLeftAnchor, enums),
    bottomRight: resolvePoint(item, enums.bottomRightAnchor, enums),
  };
}

function boundsMatch(actual: Bounds, expected: Bounds): boolean {
  return Math.abs(actual.x - expected.x) <= ROUND_TRIP_EPSILON_PT
    && Math.abs(actual.y - expected.y) <= ROUND_TRIP_EPSILON_PT
    && Math.abs(actual.width - expected.width) <= ROUND_TRIP_EPSILON_PT
    && Math.abs(actual.height - expected.height) <= ROUND_TRIP_EPSILON_PT;
}

function resolvePoint(item: unknown, anchor: unknown, enums: PageGeometryEnums): readonly [number, number] {
  // The location-space member is optional. InDesign 21.4 returns collapsed
  // bounds for PageItem proxies when PAGE_COORDINATES is supplied there, so
  // request the bounded anchor and use the explicit output space instead.
  const raw = callMember(item, "resolve", [
    [anchor, enums.geometricPathBounds],
    enums.pageCoordinates,
    false,
  ]);
  const rawValues: readonly unknown[] | undefined = Array.isArray(raw) ? raw as unknown[] : undefined;
  const nested = rawValues?.[0];
  const candidate: unknown = Array.isArray(nested) ? nested as unknown[] : raw;
  if (!Array.isArray(candidate) || candidate.length < 2) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign did not resolve a page-relative item point.");
  }
  const values = candidate as unknown[];
  const x: unknown = values[0];
  const y: unknown = values[1];
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "InDesign returned non-numeric page-relative item coordinates.");
  }
  return [x, y];
}

function assertGeometryEnums(enums: PageGeometryEnums): void {
  if (
    enums.pageCoordinates === undefined
    || enums.topLeftAnchor === undefined
    || enums.bottomRightAnchor === undefined
    || enums.geometricPathBounds === undefined
  ) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "Required page-coordinate geometry enums are unavailable.");
  }
}
