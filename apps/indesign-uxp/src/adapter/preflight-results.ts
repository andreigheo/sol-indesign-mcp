import { SafeBridgeError } from "../core/errors";
import { safeText } from "../core/records";

export interface PreflightFinding {
  category: string;
  message: string;
  details?: string[];
}

export interface ParsedPreflightResults {
  byCategory: Record<string, PreflightFinding[]>;
  colorFindings: PreflightFinding[];
  total: number;
  totalReturned: number;
  truncated: boolean;
}

const MAX_CATEGORIES = 100;
const OTHER_CATEGORY = "Other preflight findings";
const PREFLIGHT_WAIT_SECONDS = 100;

export async function waitForPreflightCompletion(
  waitForProcess: (waitTimeSeconds: number) => unknown,
): Promise<void> {
  // Adobe documents the maximum wait but not the Boolean return semantics.
  // InDesign 21.4 / UXP 9.3 was observed returning false after the wait, so
  // the documented aggregatedResults shape below is the completion evidence.
  await waitForProcess(PREFLIGHT_WAIT_SECONDS);
}

export function parsePreflightResults(value: unknown, maxFindings: number): ParsedPreflightResults {
  if (!Array.isArray(value) || value.length < 3 || !Array.isArray(value[2])) {
    throw unsupportedResults();
  }
  const rows = value[2];
  const byCategory: Record<string, PreflightFinding[]> = {};
  const colorFindings: PreflightFinding[] = [];
  let returned = 0;

  for (const rawRow of rows) {
    if (!Array.isArray(rawRow) || rawRow.length < 4) throw unsupportedResults();
    if (returned >= maxFindings) continue;
    let category = boundedText(rawRow[1], "Preflight", 255);
    if (!(category in byCategory) && Object.keys(byCategory).length >= MAX_CATEGORIES - 1) {
      category = OTHER_CATEGORY;
    }
    const message = boundedText(rawRow[3], "Preflight issue", 1_000);
    const details = parseDetails(rawRow[4]);
    const finding: PreflightFinding = {
      category,
      message,
      ...(details.length === 0 ? {} : { details }),
    };
    if (/colou?r|swatch|\bink\b/iu.test(category)) colorFindings.push(finding);
    else (byCategory[category] ??= []).push(finding);
    returned += 1;
  }

  return {
    byCategory,
    colorFindings,
    total: rows.length,
    totalReturned: returned,
    truncated: rows.length > returned,
  };
}

function parseDetails(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw unsupportedResults();
  const details: string[] = [];
  for (const rawDetail of value.slice(0, 10)) {
    if (!Array.isArray(rawDetail) || rawDetail.length === 0) throw unsupportedResults();
    const label = boundedText(rawDetail[0], "Detail", 255);
    const description = rawDetail.length > 1 ? boundedText(rawDetail[1], "", 250) : "";
    details.push(description.length === 0 ? label.slice(0, 250) : `${label}: ${description}`.slice(0, 250));
  }
  return details;
}

function boundedText(value: unknown, fallback: string, maximum: number): string {
  return (safeText(value, fallback) || fallback).slice(0, maximum);
}

function unsupportedResults(): SafeBridgeError {
  return new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    "This InDesign runtime returned an unsupported preflight result shape.",
  );
}
