import { describe, expect, it } from "vitest";

import { RevisionError, RevisionTracker } from "./revision.js";

describe("RevisionTracker", () => {
  it("starts documents at one and increments successful or partial changes", () => {
    const tracker = new RevisionTracker();
    expect(tracker.register("document-a")).toBe(1);
    expect(
      tracker.recordMutation("document-a", { documentChanged: true }),
    ).toBe(2);
    expect(
      tracker.recordMutation("document-a", {
        documentChanged: false,
        partialChanges: true,
      }),
    ).toBe(3);
    expect(
      tracker.recordMutation("document-a", { documentChanged: false }),
    ).toBe(3);
  });

  it("rejects stale expected revisions with bounded details", () => {
    const tracker = new RevisionTracker();
    tracker.register("document-a", 4);
    expect(() => tracker.assertExpected("document-a", 3)).toThrow(
      RevisionError,
    );
    try {
      tracker.assertExpected("document-a", 3);
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: "STALE_DOCUMENT",
        documentUuid: "document-a",
        expectedRevision: 3,
        actualRevision: 4,
      });
    }
  });

  it("does not silently replace an existing tracked revision", () => {
    const tracker = new RevisionTracker();
    tracker.register("document-a");
    expect(() => tracker.register("document-a", 8)).toThrow(
      /already being tracked/u,
    );
  });
});
