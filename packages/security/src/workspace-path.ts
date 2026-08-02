declare const workspacePathBrand: unique symbol;

export type WorkspaceRelativePath = string & {
  readonly [workspacePathBrand]: true;
};

export type WorkspacePathErrorCode =
  | "EMPTY_PATH"
  | "PATH_TOO_LONG"
  | "NON_NFC_PATH"
  | "ABSOLUTE_PATH"
  | "DRIVE_PATH"
  | "UNC_PATH"
  | "FILE_URL"
  | "BACKSLASH"
  | "EMPTY_SEGMENT"
  | "DOT_SEGMENT"
  | "CONTROL_CHARACTER"
  | "INVALID_WINDOWS_CHARACTER"
  | "TRAILING_DOT_OR_SPACE"
  | "RESERVED_DEVICE_NAME"
  | "SEGMENT_TOO_LONG";

export class WorkspacePathError extends Error {
  readonly code: WorkspacePathErrorCode;
  readonly segmentIndex: number | undefined;

  constructor(
    code: WorkspacePathErrorCode,
    message: string,
    segmentIndex?: number,
  ) {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
    this.segmentIndex = segmentIndex;
  }
}

export interface WorkspacePathOptions {
  readonly maxPathLength?: number;
  readonly maxSegmentLength?: number;
}

export interface ValidatedWorkspacePath {
  readonly path: WorkspaceRelativePath;
  readonly segments: readonly string[];
}

export type WorkspacePathValidationResult =
  | { readonly ok: true; readonly value: ValidatedWorkspacePath }
  | { readonly ok: false; readonly error: WorkspacePathError };

const INVALID_WINDOWS_CHARACTER = /[<>:"|?*]/u;
const DRIVE_PREFIX = /^[A-Za-z]:/u;
const FILE_URL = /^file:/iu;
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])$/iu;

function containsControlCharacter(input: string): boolean {
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (
      (codePoint >= 0 && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function fail(
  code: WorkspacePathErrorCode,
  message: string,
  segmentIndex?: number,
): never {
  throw new WorkspacePathError(code, message, segmentIndex);
}

export function parseWorkspaceRelativePath(
  input: string,
  options: WorkspacePathOptions = {},
): ValidatedWorkspacePath {
  const maxPathLength = options.maxPathLength ?? 4_096;
  const maxSegmentLength = options.maxSegmentLength ?? 255;
  if (input.length === 0) {
    fail("EMPTY_PATH", "Workspace path must not be empty.");
  }
  if (input.length > maxPathLength) {
    fail("PATH_TOO_LONG", "Workspace path exceeds the configured length limit.");
  }
  if (input.normalize("NFC") !== input) {
    fail("NON_NFC_PATH", "Workspace path must already be NFC-normalized.");
  }
  if (FILE_URL.test(input)) {
    fail("FILE_URL", "File URLs are not workspace-relative paths.");
  }
  if (input.includes("\\")) {
    if (input.startsWith("\\\\")) {
      fail("UNC_PATH", "UNC paths are not allowed.");
    }
    fail("BACKSLASH", "Workspace paths must use forward slashes only.");
  }
  if (input.startsWith("//")) {
    fail("UNC_PATH", "UNC-style paths are not allowed.");
  }
  if (input.startsWith("/")) {
    fail("ABSOLUTE_PATH", "Absolute paths are not allowed.");
  }
  if (DRIVE_PREFIX.test(input)) {
    fail("DRIVE_PATH", "Drive-qualified paths are not allowed.");
  }
  if (containsControlCharacter(input)) {
    fail("CONTROL_CHARACTER", "Control characters are not allowed in paths.");
  }

  const segments = input.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      fail("EMPTY_SEGMENT", "Workspace paths cannot contain empty segments.", index);
    }
    if (segment === "." || segment === "..") {
      fail("DOT_SEGMENT", "Dot and traversal segments are not allowed.", index);
    }
    if (segment.length > maxSegmentLength) {
      fail("SEGMENT_TOO_LONG", "Path segment exceeds the length limit.", index);
    }
    if (/[ .]$/u.test(segment)) {
      fail(
        "TRAILING_DOT_OR_SPACE",
        "Windows path segments cannot end in a dot or space.",
        index,
      );
    }
    if (INVALID_WINDOWS_CHARACTER.test(segment)) {
      fail(
        "INVALID_WINDOWS_CHARACTER",
        "Path contains a character that is invalid on Windows.",
        index,
      );
    }
    const deviceStem = (segment.split(".")[0] ?? "")
      .replace(/[ .]+$/u, "")
      .toUpperCase();
    if (RESERVED_DEVICE.test(deviceStem)) {
      fail(
        "RESERVED_DEVICE_NAME",
        "Windows reserved device names are not allowed.",
        index,
      );
    }
  }

  return {
    path: input as WorkspaceRelativePath,
    segments,
  };
}

export function validateWorkspaceRelativePath(
  input: string,
  options: WorkspacePathOptions = {},
): WorkspacePathValidationResult {
  try {
    return { ok: true, value: parseWorkspaceRelativePath(input, options) };
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function isWorkspaceRelativePath(
  input: string,
): input is WorkspaceRelativePath {
  return validateWorkspaceRelativePath(input).ok;
}
