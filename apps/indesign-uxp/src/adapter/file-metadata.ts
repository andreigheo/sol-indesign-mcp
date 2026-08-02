import { SafeBridgeError } from "../core/errors";

export interface MetadataFileEntry {
  getMetadata(): Promise<{ readonly size: number; readonly isFile: boolean }>;
}

export async function readNonEmptyFileSize(file: MetadataFileEntry): Promise<number> {
  const metadata = await file.getMetadata();
  const size = metadata.size;
  if (!metadata.isFile || !Number.isSafeInteger(size) || size <= 0) {
    throw new SafeBridgeError("UXP_OPERATION_FAILED", "InDesign did not create a non-empty output file.");
  }
  return size;
}
