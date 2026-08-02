declare module "uxp" {
  export interface UxpFileSystemEntry {
    readonly name: string;
    readonly isFile: boolean;
    readonly isFolder: boolean;
    getMetadata(): Promise<{
      readonly name: string;
      readonly size: number;
      readonly isFile: boolean;
      readonly isFolder: boolean;
      readonly dateCreated?: Date;
      readonly dateModified?: Date;
    }>;
  }

  export interface UxpFile extends UxpFileSystemEntry {
    readonly isFile: true;
    readonly isFolder: false;
    read(options?: { format?: symbol }): Promise<string | ArrayBuffer>;
  }

  export interface UxpFolder extends UxpFileSystemEntry {
    readonly isFile: false;
    readonly isFolder: true;
    getEntries(): Promise<UxpFileSystemEntry[]>;
    getEntry(name: string): Promise<UxpFileSystemEntry>;
    createFile(name: string, options?: { overwrite?: boolean }): Promise<UxpFile>;
    createFolder(name: string): Promise<UxpFolder>;
  }

  export interface LocalFileSystem {
    getFolder(): Promise<UxpFolder>;
    createPersistentToken(entry: UxpFileSystemEntry): Promise<string>;
    getEntryForPersistentToken(token: string): Promise<UxpFileSystemEntry>;
    getNativePath(entry: UxpFileSystemEntry): string;
  }

  export interface SecureStorage {
    getItem(key: string): Promise<Uint8Array | null>;
    setItem(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void>;
    removeItem(key: string): Promise<void>;
  }

  export const storage: {
    readonly localFileSystem: LocalFileSystem;
    readonly secureStorage: SecureStorage;
    readonly formats: {
      readonly utf8: symbol;
      readonly binary: symbol;
    };
  };

  export const entrypoints: {
    setup(definition: {
      panels: Record<string, {
        show?(event?: unknown): void | Promise<void>;
        hide?(event?: unknown): void | Promise<void>;
        destroy?(event?: unknown): void | Promise<void>;
      }>;
    }): void;
  };
}

declare const __SOL_PLUGIN_VERSION__: string;
