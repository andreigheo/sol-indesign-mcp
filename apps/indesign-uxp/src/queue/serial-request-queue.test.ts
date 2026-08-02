import { describe, expect, it } from "vitest";
import { MAX_QUEUE_DEPTH, SerialRequestQueue } from "./serial-request-queue";

describe("UXP serial request queue", () => {
  it("runs host work in FIFO order", async () => {
    const queue = new SerialRequestQueue();
    const order: number[] = [];
    const first = queue.enqueue("first", 1_000, async () => {
      await Promise.resolve();
      order.push(1);
    });
    const second = queue.enqueue("second", 1_000, () => { order.push(2); });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("removes a cancelled queued request before execution", async () => {
    const queue = new SerialRequestQueue();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = queue.enqueue("active", 1_000, () => gate);
    const queued = queue.enqueue("queued", 1_000, () => "should not run");
    expect(queue.cancel("queued")).toBe("queued");
    release?.();
    await active;
    await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("rejects work beyond the bounded queue capacity", async () => {
    const queue = new SerialRequestQueue();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const accepted: Promise<unknown>[] = [queue.enqueue("active", 10_000, () => gate)];
    for (let index = 1; index < MAX_QUEUE_DEPTH; index += 1) {
      accepted.push(queue.enqueue(`queued-${index}`, 10_000, () => undefined));
    }

    expect(queue.depth).toBe(MAX_QUEUE_DEPTH);
    await expect(queue.enqueue("overflow", 10_000, () => undefined)).rejects.toMatchObject({
      code: "UXP_OPERATION_FAILED",
      retryable: true,
      details: { queueLimit: MAX_QUEUE_DEPTH },
    });

    release?.();
    await Promise.all(accepted);
  });
});
