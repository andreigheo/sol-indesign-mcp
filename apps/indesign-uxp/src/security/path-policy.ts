import { parseWorkspaceRelativePath } from "@sol/security/uxp";
import { SafeBridgeError } from "../core/errors";

export interface ValidWorkspacePath {
  readonly relativePath: string;
  readonly segments: readonly string[];
}

export function validateWorkspaceRelativePath(input: unknown): ValidWorkspacePath {
  if (typeof input !== "string") throw denied("Workspace paths must be strings.");
  try {
    const parsed = parseWorkspaceRelativePath(input, { maxPathLength: 1_024, maxSegmentLength: 255 });
    return { relativePath: parsed.path, segments: parsed.segments };
  } catch (error) {
    throw denied(error instanceof Error ? error.message : "The workspace path is not allowed.");
  }
}

function denied(message: string): SafeBridgeError {
  return new SafeBridgeError("PATH_NOT_ALLOWED", message);
}
