export const REDACTED = "[REDACTED]";
export const REDACTED_CONTENT = "[REDACTED_CONTENT]";
export const REDACTED_AUTH_FRAME = "[REDACTED_AUTH_FRAME]";

export interface RedactionOptions {
  readonly sensitiveValues?: readonly string[];
  readonly sensitiveKeyPattern?: RegExp;
  readonly contentKeyPattern?: RegExp;
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
}

const DEFAULT_SENSITIVE_KEY =
  /token|secret|password|credential|authorization|cookie|nonce|digest|hmac|api[-_]?key/iu;
const DEFAULT_CONTENT_KEY =
  /^(?:text|contents?|snippet|fileContents?|data|bytes|image|documentText)$/iu;
const AUTH_FRAME_TYPE = /(?:authentication|challenge|auth)$/iu;

function replaceAllLiteral(input: string, needle: string): string {
  return needle.length === 0 ? input : input.split(needle).join(REDACTED);
}

export function redactText(
  input: string,
  sensitiveValues: readonly string[] = [],
): string {
  let output = input
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, `Bearer ${REDACTED}`)
    .replace(
      /(SOL_INDESIGN_MCP_TOKEN\s*=\s*)[^\s,;]+/giu,
      `$1${REDACTED}`,
    )
    .replace(
      /("(?:token|secret|password|authorization|digest|nonce)"\s*:\s*")[^"]*(")/giu,
      `$1${REDACTED}$2`,
    );
  for (const value of sensitiveValues) {
    output = replaceAllLiteral(output, value);
  }
  return output;
}

function truncateString(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength)}…[TRUNCATED]`;
}

export function redactValue(
  input: unknown,
  options: RedactionOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 2_048;
  const sensitiveKeyPattern =
    options.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY;
  const contentKeyPattern = options.contentKeyPattern ?? DEFAULT_CONTENT_KEY;
  const sensitiveValues = options.sensitiveValues ?? [];
  const ancestors = new WeakSet();

  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      return truncateString(
        redactText(value, sensitiveValues),
        maxStringLength,
      );
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "undefined") {
      return "[Undefined]";
    }
    if (typeof value === "function" || typeof value === "symbol") {
      return `[${typeof value}]`;
    }
    if (depth >= maxDepth) {
      return "[MaxDepth]";
    }
    if (value instanceof Uint8Array) {
      return `[REDACTED_BINARY: ${value.byteLength} bytes]`;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: truncateString(
          redactText(value.message, sensitiveValues),
          maxStringLength,
        ),
      };
    }
    if (ancestors.has(value)) {
      return "[Circular]";
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => visit(item, depth + 1));
      }

      const record = value as Record<string, unknown>;
      const type = record.type;
      if (typeof type === "string" && AUTH_FRAME_TYPE.test(type)) {
        return { type, frame: REDACTED_AUTH_FRAME };
      }

      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(record)) {
        if (sensitiveKeyPattern.test(key)) {
          result[key] = REDACTED;
        } else if (contentKeyPattern.test(key)) {
          result[key] = REDACTED_CONTENT;
        } else {
          result[key] = visit(item, depth + 1);
        }
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  return visit(input, 0);
}
