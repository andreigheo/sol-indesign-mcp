export function isFileEntryInteropRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const mentionsFileEntry = message.includes("file entry")
    || message.includes("uxp file")
    || message.includes("file object")
    || message.includes("file argument");
  const indicatesTypeRejection = message.includes("unsupported")
    || message.includes("not supported")
    || message.includes("expected")
    || message.includes("invalid type")
    || message.includes("not a valid");
  return mentionsFileEntry && indicatesTypeRejection;
}

export function executeWithStrictFileEntryFallback<TEntry, TResult>(
  entry: TEntry,
  nativePath: () => string,
  operation: (file: TEntry | string) => TResult,
): TResult {
  try {
    return operation(entry);
  } catch (error) {
    if (!isFileEntryInteropRejection(error)) throw error;
    return operation(nativePath());
  }
}

export async function executeAsyncWithStrictFileEntryFallback<TEntry, TResult>(
  entry: TEntry,
  nativePath: () => string,
  operation: (file: TEntry | string) => TResult | PromiseLike<TResult>,
): Promise<TResult> {
  try {
    return await operation(entry);
  } catch (error) {
    if (!isFileEntryInteropRejection(error)) throw error;
    return await operation(nativePath());
  }
}
