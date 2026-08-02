import { isRecord } from "../core/records";

const MAX_ENTRIES = 200;
const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(?:authorization|credential|digest|nonce|secret|token|contents?|story|text|nativepath|stack)/iu;

export interface DiagnosticEntry {
  readonly timestamp: string;
  readonly level: "info" | "warning" | "error";
  readonly event: string;
  readonly data?: unknown;
}

export class DiagnosticRing {
  #entries: DiagnosticEntry[] = [];

  add(level: DiagnosticEntry["level"], event: string, data?: unknown): void {
    const entry: DiagnosticEntry = {
      timestamp: new Date().toISOString(),
      level,
      event: event.replace(/[\r\n\t]+/gu, " ").slice(0, 96),
      ...(data === undefined ? {} : { data: redact(data, 0) }),
    };
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
  }

  snapshot(): readonly DiagnosticEntry[] {
    return this.#entries.slice();
  }

  async copy(summary: Record<string, unknown>): Promise<void> {
    const payload = {
      generatedAt: new Date().toISOString(),
      summary: redact(summary, 0),
      events: this.snapshot(),
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  }
}

function redact(value: unknown, depth: number): unknown {
  if (depth > 5) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(/[\r\n\t]+/gu, " ").slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }
  return `[unsupported ${typeof value}]`;
}
