import { describe, expect, it } from "vitest";

import {
  isWorkspaceRelativePath,
  parseWorkspaceRelativePath,
  validateWorkspaceRelativePath,
  WorkspacePathError,
} from "./workspace-path.js";

describe("workspace-relative path policy", () => {
  it.each([
    "previews/page-1.png",
    "exports/Client Deck/document.indd",
    "assets/éclair/image.jpg",
    "one.ext/many.dots.name.pdf",
  ])("accepts a safe normalized path: %s", (path) => {
    const parsed = parseWorkspaceRelativePath(path);
    expect(parsed.path).toBe(path);
    expect(parsed.segments).toEqual(path.split("/"));
    expect(isWorkspaceRelativePath(path)).toBe(true);
  });

  it.each([
    ["", "EMPTY_PATH"],
    ["/absolute/file.pdf", "ABSOLUTE_PATH"],
    ["//server/share/file.pdf", "UNC_PATH"],
    ["\\\\server\\share\\file.pdf", "UNC_PATH"],
    ["C:/absolute/file.pdf", "DRIVE_PATH"],
    ["file:///C:/file.pdf", "FILE_URL"],
    ["folder\\file.pdf", "BACKSLASH"],
    ["folder//file.pdf", "EMPTY_SEGMENT"],
    ["folder/./file.pdf", "DOT_SEGMENT"],
    ["folder/../file.pdf", "DOT_SEGMENT"],
    ["folder/file.pdf/", "EMPTY_SEGMENT"],
    ["folder/control\u0000.pdf", "CONTROL_CHARACTER"],
    ["folder/name:stream", "INVALID_WINDOWS_CHARACTER"],
    ["folder/name?.pdf", "INVALID_WINDOWS_CHARACTER"],
    ["folder/trailing.", "TRAILING_DOT_OR_SPACE"],
    ["folder/trailing ", "TRAILING_DOT_OR_SPACE"],
    ["CON", "RESERVED_DEVICE_NAME"],
    ["folder/con.txt", "RESERVED_DEVICE_NAME"],
    ["folder/LPT9.log", "RESERVED_DEVICE_NAME"],
    ["folder/COM¹.txt", "RESERVED_DEVICE_NAME"],
    ["folder/e\u0301clair.pdf", "NON_NFC_PATH"],
  ])("rejects %s as %s", (path, expectedCode) => {
    const result = validateWorkspaceRelativePath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WorkspacePathError);
      expect(result.error.code).toBe(expectedCode);
    }
    expect(isWorkspaceRelativePath(path)).toBe(false);
  });

  it("enforces configurable path and segment bounds", () => {
    expect(() =>
      parseWorkspaceRelativePath("folder/file", { maxPathLength: 5 }),
    ).toThrow(/length limit/u);
    expect(() =>
      parseWorkspaceRelativePath("folder/file", { maxSegmentLength: 4 }),
    ).toThrow(/segment/u);
  });
});
