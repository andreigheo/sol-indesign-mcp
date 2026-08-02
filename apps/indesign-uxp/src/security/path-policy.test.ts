import { describe, expect, it } from "vitest";
import { validateWorkspaceRelativePath } from "./path-policy";

describe("UXP workspace path policy", () => {
  it("accepts normalized workspace-relative paths", () => {
    expect(validateWorkspaceRelativePath("previews/layout-01.png").segments).toEqual(["previews", "layout-01.png"]);
  });

  it.each([
    "../secret.indd",
    "/absolute/file.indd",
    "C:/file.indd",
    "file:///tmp/file.indd",
    "folder\\file.indd",
    "folder//file.indd",
    "folder/CON.txt",
    "folder/trailing. ",
  ])("rejects %s", (candidate) => {
    expect(() => validateWorkspaceRelativePath(candidate)).toThrow();
  });
});
