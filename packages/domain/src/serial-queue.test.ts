import { describe, expect, it } from "vitest";

import { SerialQueue, SerialQueueError } from "./serial-queue.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("SerialQueue", () => {
  it("executes work strictly in FIFO order", async () => {
    const queue = new SerialQueue();
    const gate = deferred<undefined>();
    const events: string[] = [];
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = queue.enqueue(() => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(queue.snapshot().depth).toBe(2);
    gate.resolve(undefined);
    await Promise.all([first, second, queue.onIdle()]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("removes aborted queued work before it starts", async () => {
    const queue = new SerialQueue();
    const gate = deferred<undefined>();
    const controller = new AbortController();
    const first = queue.enqueue(() => gate.promise, { id: "active" });
    const ran: string[] = [];
    const queued = queue.enqueue(
      () => {
        ran.push("queued");
      },
      { id: "queued", signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort("not needed");
    await expect(queued).rejects.toMatchObject({ code: "QUEUE_CANCELLED" });
    expect(ran).toEqual([]);
    gate.resolve(undefined);
    await first;
  });

  it("does not claim that already-started work was cancelled", async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    const gate = deferred<string>();
    const active = queue.enqueue(() => gate.promise, {
      id: "synchronous-dom",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    expect(queue.cancel("synchronous-dom")).toBe(false);
    gate.resolve("completed");
    await expect(active).resolves.toBe("completed");
  });

  it("expires only work that is still queued", async () => {
    const queue = new SerialQueue();
    const gate = deferred<undefined>();
    const first = queue.enqueue(() => gate.promise);
    const expired = queue.enqueue(() => "unexpected", { timeoutMs: 5 });
    await expect(expired).rejects.toMatchObject({
      code: "QUEUE_DEADLINE_EXCEEDED",
    });
    gate.resolve(undefined);
    await first;
  });

  it("rejects duplicate IDs and keeps processing after failures", async () => {
    const queue = new SerialQueue();
    const gate = deferred<undefined>();
    const first = queue.enqueue(() => gate.promise, { id: "same" });
    await expect(queue.enqueue(() => undefined, { id: "same" })).rejects.toBeInstanceOf(
      SerialQueueError,
    );
    gate.resolve(undefined);
    await first;
    await expect(
      queue.enqueue(() => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    await expect(queue.enqueue(() => 42)).resolves.toBe(42);
  });
});
