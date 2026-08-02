import { mkdir, rename, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { redactValue } from "@sol/security";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AuditFields {
  readonly traceId?: string;
  readonly tool?: string;
  readonly bridgeMethod?: string;
  readonly durationMs?: number;
  readonly resultCode?: string;
  readonly changedObjectCount?: number;
  readonly [key: string]: unknown;
}

export class JsonLogger {
  readonly #directory: string;
  readonly #file: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = directory;
    this.#file = join(directory, "audit.jsonl");
  }

  log(level: LogLevel, message: string, fields: AuditFields = {}): void {
    const record = redactValue(
      { timestamp: new Date().toISOString(), level, message, ...fields },
      { maxDepth: 6, maxStringLength: 2_000 },
    );
    const line = `${JSON.stringify(record)}\n`;
    process.stderr.write(line);
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(this.#directory, { recursive: true });
      await this.#rotateIfNeeded(Buffer.byteLength(line));
      await appendFile(this.#file, line, { encoding: "utf8", mode: 0o600 });
    }).catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : "UnknownLogError";
      process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "audit_write_failed", errorName })}\n`);
    });
  }

  async flush(): Promise<void> {
    await this.#writeChain;
  }

  async #rotateIfNeeded(incomingBytes: number): Promise<void> {
    const current = await stat(this.#file).then((value) => value.size).catch(() => undefined);
    if (current === undefined) return;
    if (current + incomingBytes <= 5 * 1024 * 1024) return;
    for (let index = 4; index >= 1; index -= 1) {
      const source = `${this.#file}.${index}`;
      const target = `${this.#file}.${index + 1}`;
      try { await rename(source, target); } catch { /* missing rotation segment */ }
    }
    try { await rename(this.#file, `${this.#file}.1`); } catch { await writeFile(this.#file, ""); }
  }
}
