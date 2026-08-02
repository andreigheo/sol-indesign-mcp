import { SafeBridgeError } from "./errors";

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new SafeBridgeError("INVALID_INPUT", `${label} must be an object.`);
  return value;
}

export function readString(record: UnknownRecord, key: string, options: { required?: boolean; max?: number } = {}): string | undefined {
  const value = record[key];
  if (value === undefined && options.required !== true) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > (options.max ?? 512)) {
    throw new SafeBridgeError("INVALID_INPUT", `${key} must be a non-empty string.`);
  }
  return value;
}

export function readNumber(record: UnknownRecord, key: string, options: { required?: boolean; min?: number; max?: number; integer?: boolean } = {}): number | undefined {
  const value = record[key];
  if (value === undefined && options.required !== true) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SafeBridgeError("INVALID_INPUT", `${key} must be a finite number.`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw new SafeBridgeError("INVALID_INPUT", `${key} must be an integer.`);
  }
  if (value < (options.min ?? -Number.MAX_VALUE) || value > (options.max ?? Number.MAX_VALUE)) {
    throw new SafeBridgeError("INVALID_INPUT", `${key} is outside the allowed range.`);
  }
  return value;
}

export function readBoolean(record: UnknownRecord, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new SafeBridgeError("INVALID_INPUT", `${key} must be a boolean.`);
  return value;
}

export function getMember(target: unknown, key: string): unknown {
  if ((typeof target !== "object" || target === null) && typeof target !== "function") return undefined;
  return Reflect.get(target, key);
}

export function setMember(target: unknown, key: string, value: unknown): void {
  if ((typeof target !== "object" || target === null) && typeof target !== "function") {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `InDesign does not expose ${key}.`);
  }
  if (!Reflect.set(target, key, value)) {
    throw new SafeBridgeError("UXP_OPERATION_FAILED", `InDesign rejected ${key}.`);
  }
}

export function callMember(target: unknown, key: string, args: readonly unknown[] = []): unknown {
  const member = getMember(target, key);
  if (typeof member !== "function") {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `This InDesign runtime does not support ${key}.`);
  }
  return Reflect.apply(member, target, args);
}

export function hasMethod(target: unknown, key: string): boolean {
  return typeof getMember(target, key) === "function";
}

export function collectionItems(collection: unknown, limit = 10_000): unknown[] {
  if (collection === undefined || collection === null) return [];
  if (Array.isArray(collection)) return collection.slice(0, limit);
  const length = getMember(collection, "length");
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0) return [];
  const output: unknown[] = [];
  for (let index = 0; index < Math.min(Math.trunc(length), limit); index += 1) {
    let item = getMember(collection, String(index));
    if (item === undefined && hasMethod(collection, "item")) {
      try {
        item = callMember(collection, "item", [index]);
      } catch {
        item = undefined;
      }
    }
    if (item !== undefined && item !== null && getMember(item, "isValid") !== false) output.push(item);
  }
  return output;
}

export function collectionLength(collection: unknown): number | undefined {
  if (Array.isArray(collection)) return collection.length;
  const length = getMember(collection, "length");
  return typeof length === "number" && Number.isInteger(length) && length >= 0 ? length : undefined;
}

export function safeText(value: unknown, fallback = "", maximum = 256): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  let normalized = "";
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    normalized += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }
  const text = normalized.trim();
  return text.slice(0, maximum);
}

export function nativeId(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}
