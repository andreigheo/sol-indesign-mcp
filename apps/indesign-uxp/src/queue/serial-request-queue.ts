import { SafeBridgeError } from "../core/errors";

export const MAX_QUEUE_DEPTH = 100;

interface QueueEntry<T> {
  readonly id: string;
  readonly enqueuedAt: number;
  readonly deadlineAt: number;
  readonly task: () => T | Promise<T>;
  readonly resolve: (result: T) => void;
  readonly reject: (reason: unknown) => void;
}

export class SerialRequestQueue {
  #pending: QueueEntry<unknown>[] = [];
  #activeId: string | undefined;
  #activeCancellationRequested = false;
  #draining = false;
  #onDepthChanged: ((depth: number) => void) | undefined;

  constructor(onDepthChanged?: (depth: number) => void) {
    this.#onDepthChanged = onDepthChanged;
  }

  get depth(): number {
    return this.#pending.length + (this.#activeId === undefined ? 0 : 1);
  }

  enqueue<T>(id: string, deadlineMs: number, task: () => T | Promise<T>): Promise<T> {
    if (this.depth >= MAX_QUEUE_DEPTH) {
      return Promise.reject(new SafeBridgeError(
        "UXP_OPERATION_FAILED",
        "The InDesign request queue is at its bounded capacity. Try again after queued work completes.",
        { retryable: true, details: { queueLimit: MAX_QUEUE_DEPTH } },
      ));
    }
    const duration = Number.isFinite(deadlineMs) ? Math.min(Math.max(deadlineMs, 1), 120_000) : 30_000;
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        id,
        enqueuedAt: Date.now(),
        deadlineAt: Date.now() + duration,
        task,
        resolve,
        reject,
      };
      this.#pending.push(entry as QueueEntry<unknown>);
      this.#notify();
      void this.#drain();
    });
  }

  cancel(id: string): "queued" | "active" | "missing" {
    const index = this.#pending.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      const [entry] = this.#pending.splice(index, 1);
      entry?.reject(new SafeBridgeError("CANCELLED", "The request was cancelled before it started.", { retryable: true }));
      this.#notify();
      return "queued";
    }
    if (this.#activeId === id) {
      this.#activeCancellationRequested = true;
      return "active";
    }
    return "missing";
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#pending.length > 0) {
        const entry = this.#pending.shift();
        if (entry === undefined) continue;
        if (Date.now() >= entry.deadlineAt) {
          entry.reject(new SafeBridgeError("DEADLINE_EXCEEDED", "The request expired while waiting for InDesign.", { retryable: true }));
          this.#notify();
          continue;
        }
        this.#activeId = entry.id;
        this.#activeCancellationRequested = false;
        this.#notify();
        try {
          const result = await entry.task();
          if (this.#consumeActiveCancellation()) {
            throw new SafeBridgeError("CANCELLED", "Cancellation arrived during a non-interruptible InDesign call; the request may have completed.", {
              details: { mayHaveCompleted: true, nonInterruptible: true },
            });
          }
          if (Date.now() >= entry.deadlineAt) {
            throw new SafeBridgeError("DEADLINE_EXCEEDED", "The non-interruptible InDesign call exceeded its deadline and may have completed.", {
              details: { mayHaveCompleted: true, nonInterruptible: true },
            });
          }
          entry.resolve(result);
        } catch (error) {
          entry.reject(error);
        } finally {
          this.#activeId = undefined;
          this.#activeCancellationRequested = false;
          this.#notify();
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #notify(): void {
    this.#onDepthChanged?.(this.depth);
  }

  #consumeActiveCancellation(): boolean {
    const requested = this.#activeCancellationRequested;
    this.#activeCancellationRequested = false;
    return requested;
  }
}
