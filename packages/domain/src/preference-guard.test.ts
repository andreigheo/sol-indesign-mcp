import { describe, expect, it } from "vitest";

import {
  preferenceField,
  PreferenceRestoreError,
  PreferenceSnapshotError,
  withPreferenceGuard,
} from "./preference-guard.js";

describe("withPreferenceGuard", () => {
  it("restores only explicitly listed fields after success", async () => {
    const preferences = { resolution: 72, format: "png", untouched: true };
    const result = await withPreferenceGuard(
      [
        preferenceField(preferences, "resolution"),
        preferenceField(preferences, "format"),
      ],
      () => {
        preferences.resolution = 300;
        preferences.format = "jpeg";
        preferences.untouched = false;
        return "ok";
      },
    );
    expect(result).toBe("ok");
    expect(preferences).toEqual({
      resolution: 72,
      format: "png",
      untouched: false,
    });
  });

  it("restores preferences after an operation error and rethrows it", async () => {
    const preferences = { page: "1" };
    const failure = new Error("export failed");
    await expect(
      withPreferenceGuard([preferenceField(preferences, "page")], () => {
        preferences.page = "2";
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(preferences.page).toBe("1");
  });

  it("fails closed when a touched field is unreadable", async () => {
    await expect(
      withPreferenceGuard(
        [
          {
            name: "unsupported",
            read: () => {
              throw new Error("not readable");
            },
            restore: () => undefined,
          },
        ],
        () => "never",
      ),
    ).rejects.toBeInstanceOf(PreferenceSnapshotError);
  });

  it("reports restoration failures without hiding the operation error", async () => {
    const operationError = new Error("export failed");
    const promise = withPreferenceGuard(
      [
        {
          name: "resolution",
          read: () => 72,
          restore: () => {
            throw new Error("restore failed");
          },
        },
      ],
      () => {
        throw operationError;
      },
    );
    await expect(promise).rejects.toBeInstanceOf(PreferenceRestoreError);
    try {
      await promise;
    } catch (error: unknown) {
      expect(error).toMatchObject({ operationError });
    }
  });
});
