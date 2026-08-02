import { SafeBridgeError } from "../core/errors";

export interface BinaryReadableFile {
  read(options?: { readonly format?: symbol }): Promise<string | ArrayBuffer>;
}

export async function readBinaryFile(file: BinaryReadableFile, binaryFormat: symbol): Promise<Uint8Array> {
  const data = await file.read({ format: binaryFormat });
  if (!(data instanceof ArrayBuffer)) {
    throw new SafeBridgeError(
      "UNSUPPORTED_CAPABILITY",
      "UXP did not return binary data for the exported preview.",
    );
  }
  return new Uint8Array(data);
}
