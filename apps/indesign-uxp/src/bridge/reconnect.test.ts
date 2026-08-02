import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./client";

describe("bridge reconnect backoff", () => {
  it("is bounded between 500 ms and 15 seconds", () => {
    expect(reconnectDelay(0, () => 0)).toBe(500);
    expect(reconnectDelay(50, () => 1)).toBe(15_000);
  });
});
