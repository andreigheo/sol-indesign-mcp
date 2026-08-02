import { storage } from "uxp";
import type { UxpFile, UxpFileSystemEntry, UxpFolder } from "uxp";
import { SafeBridgeError } from "../core/errors";
import { validateWorkspaceRelativePath } from "./path-policy";

const PERSISTENT_TOKEN_KEY = "sol.indesign-mcp.workspace-token.v1";

export interface WorkspaceStatus {
  authorized: boolean;
  name?: string;
  stale: boolean;
}

export class WorkspaceManager {
  #root: UxpFolder | undefined;
  #stale = false;

  async restore(): Promise<WorkspaceStatus> {
    const token = localStorage.getItem(PERSISTENT_TOKEN_KEY);
    if (token === null) return { authorized: false, stale: false };
    try {
      const entry = await storage.localFileSystem.getEntryForPersistentToken(token);
      if (!entry.isFolder) throw new Error("Persistent entry is not a folder");
      this.#root = entry as UxpFolder;
      this.#stale = false;
      return { authorized: true, name: entry.name, stale: false };
    } catch {
      this.#root = undefined;
      this.#stale = true;
      localStorage.removeItem(PERSISTENT_TOKEN_KEY);
      return { authorized: false, stale: true };
    }
  }

  async authorize(): Promise<WorkspaceStatus> {
    const root = await storage.localFileSystem.getFolder();
    const token = await storage.localFileSystem.createPersistentToken(root);
    localStorage.setItem(PERSISTENT_TOKEN_KEY, token);
    this.#root = root;
    this.#stale = false;
    return { authorized: true, name: root.name, stale: false };
  }

  clear(): WorkspaceStatus {
    localStorage.removeItem(PERSISTENT_TOKEN_KEY);
    this.#root = undefined;
    this.#stale = false;
    return { authorized: false, stale: false };
  }

  status(): WorkspaceStatus {
    return {
      authorized: this.#root !== undefined,
      ...(this.#root === undefined ? {} : { name: this.#root.name }),
      stale: this.#stale,
    };
  }

  async resolveExisting(relativePath: unknown, expected: "file" | "folder" = "file"): Promise<UxpFileSystemEntry> {
    const root = this.#requiredRoot();
    const validated = validateWorkspaceRelativePath(relativePath);
    let current: UxpFileSystemEntry = root;
    for (const segment of validated.segments) {
      if (!current.isFolder) throw new SafeBridgeError("PATH_NOT_ALLOWED", "A workspace path traverses through a file.");
      try {
        current = await (current as UxpFolder).getEntry(segment);
      } catch {
        throw new SafeBridgeError("FILE_NOT_FOUND", "The requested workspace entry does not exist.");
      }
    }
    if ((expected === "file" && !current.isFile) || (expected === "folder" && !current.isFolder)) {
      throw new SafeBridgeError("PATH_NOT_ALLOWED", `The workspace entry is not a ${expected}.`);
    }
    return current;
  }

  async resolveOutput(relativePath: unknown, overwrite = false): Promise<UxpFile> {
    const root = this.#requiredRoot();
    const validated = validateWorkspaceRelativePath(relativePath);
    const filename = validated.segments[validated.segments.length - 1];
    if (filename === undefined) throw new SafeBridgeError("PATH_NOT_ALLOWED", "An output filename is required.");
    let folder = root;
    for (const segment of validated.segments.slice(0, -1)) {
      folder = await this.#resolveOrCreateFolder(folder, segment);
    }

    let existing: UxpFileSystemEntry | undefined;
    try {
      existing = await folder.getEntry(filename);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && !existing.isFile) {
      throw new SafeBridgeError("PATH_NOT_ALLOWED", "The output path already exists as a folder.");
    }
    if (existing?.isFile === true && !overwrite) {
      throw new SafeBridgeError("FILE_EXISTS", "The output file already exists. Set overwrite to true to replace it.");
    }
    try {
      return await folder.createFile(filename, { overwrite });
    } catch (error) {
      if (!overwrite) throw new SafeBridgeError("FILE_EXISTS", "The output file already exists.");
      throw error;
    }
  }

  nativePathForDom(entry: UxpFileSystemEntry): string {
    const nativePath = storage.localFileSystem.getNativePath(entry);
    if (typeof nativePath !== "string" || nativePath.length === 0) {
      throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", "This UXP runtime cannot provide a native path for an authorized entry.");
    }
    return nativePath;
  }

  #requiredRoot(): UxpFolder {
    if (this.#root === undefined) {
      throw new SafeBridgeError("WORKSPACE_REQUIRED", "Select a workspace folder in the Sol Bridge panel first.", { retryable: true });
    }
    return this.#root;
  }

  async #resolveOrCreateFolder(parent: UxpFolder, name: string): Promise<UxpFolder> {
    try {
      const existing = await parent.getEntry(name);
      if (!existing.isFolder) throw new SafeBridgeError("PATH_NOT_ALLOWED", "An output folder segment already exists as a file.");
      return existing as UxpFolder;
    } catch (error) {
      if (error instanceof SafeBridgeError) throw error;
      return parent.createFolder(name);
    }
  }
}
