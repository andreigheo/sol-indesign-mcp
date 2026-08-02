import { SafeBridgeError } from "../core/errors";
import { getMember } from "../core/records";

const KNOWN_PROTECTED_RESOURCES = new Set([
  "[none]",
  "[paper]",
  "[black]",
  "[registration]",
  "[basic paragraph]",
  "[no paragraph style]",
  "[basic graphics frame]",
  "[basic text frame]",
]);
export function assertMutableResourceName(name: string): void {
  if (KNOWN_PROTECTED_RESOURCES.has(name.toLowerCase()) || isBracketedBuiltInName(name)) {
    throw protectedResource(name);
  }
}

/** Re-checks the host object so localized bracketed built-ins also fail closed. */
export function assertMutableResourceObject(resource: unknown, requestedName: string): void {
  assertMutableResourceName(requestedName);
  const runtimeName = getMember(resource, "name");
  if (
    (typeof runtimeName === "string" && isBracketedBuiltInName(runtimeName))
    || getMember(resource, "isBuiltIn") === true
    || getMember(resource, "builtIn") === true
  ) {
    throw protectedResource(typeof runtimeName === "string" ? runtimeName : requestedName);
  }
}

function isBracketedBuiltInName(value: string): boolean {
  if (value.length < 3 || value.length > 257 || !value.startsWith("[") || !value.endsWith("]")) return false;
  const inner = value.slice(1, -1);
  return !inner.includes("[") && !inner.includes("]") && !inner.includes("\r") && !inner.includes("\n");
}

function protectedResource(name: string): SafeBridgeError {
  return new SafeBridgeError("INVALID_INPUT", `The built-in resource '${name}' cannot be created or updated.`);
}
