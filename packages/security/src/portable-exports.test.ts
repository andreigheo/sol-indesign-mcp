import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("portable security exports", () => {
  it("do not pull Node built-ins into the generic or UXP entry points", async () => {
    const sources = await Promise.all(
      ["index.ts", "uxp.ts", "hmac.ts", "token.ts", "base64url.ts"].map(
        (file) => readFile(new URL(file, import.meta.url), "utf8"),
      ),
    );
    expect(sources.join("\n")).not.toMatch(/from\s+["']node:/u);
  });
});
