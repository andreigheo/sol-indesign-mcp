export type QueueErrorCode =
  | "QUEUE_CANCELLED"
  | "QUEUE_CLOSED"
  | "QUEUE_DEADLINE_EXCEEDED"
  | "DUPLICATE_QUEUE_TASK";

export class SerialQueueError extends Error {
  readonly code: QueueErrorCode;
  readonly taskId: string;
  readonly reason: unknown;

  constructor(
    code: QueueErrorCode,
    taskId: string,
    message: string,
    reason?: unknown,
  ) {
    super(message);
    this.name = "SerialQueueError";
    this.code = code;
    this.taskId = taskId;
    this.reason = reason;
  }
}

export interface QueueTaskContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly enqueuedAt: number;
  readonly startedAt: number;
  readonly deadlineAt: number | undefined;
}

export interface EnqueueOptions {
  readonly id?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadlineAt?: number;
}

export interface QueueSnapshot {
  readonly activeTaskId: string | null;
  readonly queuedTaskIds: readonly string[];
  readonly depth: number;
  readonly closed: boolean;
}

interface QueueEntry {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly enqueuedAt: number;
  readonly deadlineAt: number | undefined;
  readonly execute: (startedAt: number) => Promise<void>;
  readonly reject: (error: SerialQueueError) => void;
  abortListener: (() => void) | undefined;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  state: "queued" | "active" | "settled";
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

export class SerialQueue {
  readonly #entries: QueueEntry[] = [];
  readonly #ids = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  #active: QueueEntry | undefined;
  #closed = false;
  #sequence = 0;

  enqueue<T>(
    task: (context: QueueTaskContext) => Promise<T> | T,
    options: EnqueueOptions = {},
  ): Promise<T> {
    const id = options.id ?? `queue-${++this.#sequence}`;
    if (this.#ids.has(id)) {
      return Promise.reject(
        new SerialQueueError(
          "DUPLICATE_QUEUE_TASK",
          id,
          `Queue task ID already exists: ${id}.`,
        ),
      );
    }
    if (this.#closed) {
      return Promise.reject(
        new SerialQueueError("QUEUE_CLOSED", id, "Serial queue is closed."),
      );
    }

    const enqueuedAt = Date.now();
    const deadlineAt = this.#resolveDeadline(enqueuedAt, options);
    const signal = options.signal ?? NEVER_ABORTED_SIGNAL;
    if (signal.aborted) {
      return Promise.reject(
        new SerialQueueError(
          "QUEUE_CANCELLED",
          id,
          "Queue task was cancelled before it was enqueued.",
          signal.reason,
        ),
      );
    }
    if (deadlineAt !== undefined && deadlineAt <= enqueuedAt) {
      return Promise.reject(
        new SerialQueueError(
          "QUEUE_DEADLINE_EXCEEDED",
          id,
          "Queue task deadline elapsed before it was enqueued.",
        ),
      );
    }

    let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
    let rejectPromise: (reason?: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const entry: QueueEntry = {
      id,
      signal,
      enqueuedAt,
      deadlineAt,
      state: "queued",
      abortListener: undefined,
      deadlineTimer: undefined,
      reject: rejectPromise,
      execute: async (startedAt) => {
        try {
          const result = await task({
            taskId: id,
            signal,
            enqueuedAt,
            startedAt,
            deadlineAt,
          });
          resolvePromise(result);
        } catch (error: unknown) {
          rejectPromise(error);
        }
      },
    };

    entry.abortListener = () => {
      this.#cancelQueuedEntry(
        entry,
        new SerialQueueError(
          "QUEUE_CANCELLED",
          id,
          "Queue task was cancelled before it started.",
          signal.reason,
        ),
      );
    };
    signal.addEventListener("abort", entry.abortListener, { once: true });

    if (deadlineAt !== undefined) {
      const delay = Math.max(0, Math.min(deadlineAt - enqueuedAt, 2_147_483_647));
      entry.deadlineTimer = setTimeout(() => {
        this.#cancelQueuedEntry(
          entry,
          new SerialQueueError(
            "QUEUE_DEADLINE_EXCEEDED",
            id,
            "Queue task deadline elapsed before it started.",
          ),
        );
      }, delay);
    }

    this.#ids.add(id);
    this.#entries.push(entry);
    this.#schedulePump();
    return promise;
  }

  cancel(taskId: string, reason?: unknown): boolean {
    const entry = this.#entries.find((candidate) => candidate.id === taskId);
    if (entry === undefined) {
      return false;
    }
    return this.#cancelQueuedEntry(
      entry,
      new SerialQueueError(
        "QUEUE_CANCELLED",
        taskId,
        "Queue task was cancelled before it started.",
        reason,
      ),
    );
  }

  close(reason?: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const entry of [...this.#entries]) {
      this.#cancelQueuedEntry(
        entry,
        new SerialQueueError(
          "QUEUE_CLOSED",
          entry.id,
          "Serial queue closed before the task started.",
          reason,
        ),
      );
    }
    this.#notifyIdleIfNeeded();
  }

  snapshot(): QueueSnapshot {
    return {
      activeTaskId: this.#active?.id ?? null,
      queuedTaskIds: this.#entries.map((entry) => entry.id),
      depth: this.#entries.length + (this.#active === undefined ? 0 : 1),
      closed: this.#closed,
    };
  }

  onIdle(): Promise<void> {
    if (this.#active === undefined && this.#entries.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  #resolveDeadline(
    enqueuedAt: number,
    options: EnqueueOptions,
  ): number | undefined {
    if (options.timeoutMs !== undefined && options.deadlineAt !== undefined) {
      throw new TypeError("Specify timeoutMs or deadlineAt, not both.");
    }
    if (options.timeoutMs !== undefined) {
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
        throw new RangeError("timeoutMs must be a non-negative finite number.");
      }
      return enqueuedAt + options.timeoutMs;
    }
    if (
      options.deadlineAt !== undefined &&
      !Number.isFinite(options.deadlineAt)
    ) {
      throw new RangeError("deadlineAt must be a finite timestamp.");
    }
    return options.deadlineAt;
  }

  #schedulePump(): void {
    queueMicrotask(() => this.#pump());
  }

  #pump(): void {
    if (this.#active !== undefined) {
      return;
    }
    const entry = this.#entries.shift();
    if (entry === undefined) {
      this.#notifyIdleIfNeeded();
      return;
    }
    if (entry.state !== "queued") {
      this.#schedulePump();
      return;
    }
    if (entry.signal.aborted) {
      this.#cancelQueuedEntry(
        entry,
        new SerialQueueError(
          "QUEUE_CANCELLED",
          entry.id,
          "Queue task was cancelled before it started.",
          entry.signal.reason,
        ),
      );
      this.#schedulePump();
      return;
    }
    if (entry.deadlineAt !== undefined && entry.deadlineAt <= Date.now()) {
      this.#cancelQueuedEntry(
        entry,
        new SerialQueueError(
          "QUEUE_DEADLINE_EXCEEDED",
          entry.id,
          "Queue task deadline elapsed before it started.",
        ),
      );
      this.#schedulePump();
      return;
    }

    entry.state = "active";
    this.#cleanupQueuedHooks(entry);
    this.#active = entry;
    void entry.execute(Date.now()).finally(() => {
      entry.state = "settled";
      this.#ids.delete(entry.id);
      if (this.#active === entry) {
        this.#active = undefined;
      }
      this.#pump();
    });
  }

  #cancelQueuedEntry(entry: QueueEntry, error: SerialQueueError): boolean {
    if (entry.state !== "queued") {
      return false;
    }
    const index = this.#entries.indexOf(entry);
    if (index >= 0) {
      this.#entries.splice(index, 1);
    }
    entry.state = "settled";
    this.#cleanupQueuedHooks(entry);
    this.#ids.delete(entry.id);
    entry.reject(error);
    this.#notifyIdleIfNeeded();
    return true;
  }

  #cleanupQueuedHooks(entry: QueueEntry): void {
    if (entry.abortListener !== undefined) {
      entry.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
    if (entry.deadlineTimer !== undefined) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = undefined;
    }
  }

  #notifyIdleIfNeeded(): void {
    if (this.#active !== undefined || this.#entries.length > 0) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }
}
