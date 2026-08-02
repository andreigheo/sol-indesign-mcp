import { SafeBridgeError } from "../core/errors";

export function assertSinglePageImageExport(format: "png" | "jpeg", pageCount: number): void {
  if (pageCount === 1) return;
  throw new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    `${format.toUpperCase()} export requires exactly one explicit page because multi-file host output cannot be contained safely.`,
  );
}

export function assertSingleFilePdfPreset(exportAsSinglePages: unknown): void {
  if (exportAsSinglePages === false) return;
  throw new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    exportAsSinglePages === true
      ? "The selected PDF preset exports separate files per page and is not supported."
      : "This InDesign runtime cannot verify that the selected PDF preset produces one contained output file.",
  );
}
