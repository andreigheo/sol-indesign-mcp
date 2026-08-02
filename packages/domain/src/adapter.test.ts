import { describe, expect, it } from "vitest";

import type {
  AdapterCapabilities,
  AdapterCommandRequest,
  AdapterCommandResult,
  AdapterExecutionContext,
  InDesignAdapter,
} from "./adapter.js";

interface Commands {
  readonly status: {
    readonly request: Record<string, never>;
    readonly result: { readonly connected: boolean };
  };
  readonly create: {
    readonly request: { readonly pages: number };
    readonly result: { readonly documentUuid: string };
  };
}

class ExampleAdapter implements InDesignAdapter<Commands> {
  probeCapabilities(
    context: AdapterExecutionContext,
  ): Promise<AdapterCapabilities<Commands>> {
    expect(context.traceId).not.toBe("");
    return Promise.resolve({
      protocolVersion: "1.0",
      commands: {
        status: { supported: true },
        create: { supported: true },
      },
      runtime: { mock: true },
    });
  }

  execute<TCommand extends keyof Commands>(
    command: TCommand,
    request: AdapterCommandRequest<Commands[TCommand]>,
    context: AdapterExecutionContext,
  ): Promise<AdapterCommandResult<Commands[TCommand]>> {
    expect(context.requestId).not.toBe("");
    const result =
      command === "status"
        ? { connected: true }
        : { documentUuid: `pages:${"pages" in request ? request.pages : 0}` };
    return Promise.resolve(
      result as AdapterCommandResult<Commands[TCommand]>,
    );
  }
}

describe("InDesignAdapter contract", () => {
  it("keeps command request and result types coupled", async () => {
    const adapter = new ExampleAdapter();
    const context: AdapterExecutionContext = {
      traceId: "trace",
      requestId: "request",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
      executionMode: "interruptible",
    };
    await expect(adapter.execute("create", { pages: 2 }, context)).resolves.toEqual(
      { documentUuid: "pages:2" },
    );
    expect((await adapter.probeCapabilities(context)).commands.status).toEqual({
      supported: true,
    });
  });
});
