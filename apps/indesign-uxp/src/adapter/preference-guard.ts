import { SafeBridgeError } from "../core/errors";
import { getMember, setMember } from "../core/records";

export interface PreferenceGuard {
  restore(): void;
}

export function createPreferenceGuard(preferences: unknown, keys: readonly string[]): PreferenceGuard {
  const snapshot = snapshotPreferences(preferences, keys);

  return {
    restore(): void {
      const failures: string[] = [];
      for (const [key, value] of snapshot) {
        try {
          setMember(preferences, key, value);
        } catch {
          failures.push(key);
        }
      }
      if (failures.length > 0) {
        throw new SafeBridgeError(
          "UXP_OPERATION_FAILED",
          "InDesign could not restore one or more export preferences.",
          { details: { preferenceKeys: failures.slice(0, 16) } },
        );
      }
    },
  };
}

export function assertPreferencesReadable(preferences: unknown, keys: readonly string[]): void {
  snapshotPreferences(preferences, keys);
}

function snapshotPreferences(preferences: unknown, keys: readonly string[]): Map<string, unknown> {
  const snapshot = new Map<string, unknown>();
  for (const key of keys) {
    let value: unknown;
    try {
      value = getMember(preferences, key);
    } catch {
      throw unavailablePreference(key);
    }
    if (value === undefined) throw unavailablePreference(key);
    snapshot.set(key, value);
  }
  return snapshot;
}

function unavailablePreference(key: string): SafeBridgeError {
  return new SafeBridgeError(
    "UNSUPPORTED_CAPABILITY",
    `This InDesign runtime does not expose the required ${key} export preference.`,
  );
}
