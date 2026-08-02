export interface AdapterCommandDefinition<TRequest, TResult> {
  readonly request: TRequest;
  readonly result: TResult;
}

export type AdapterCommandRequest<TDefinition> =
  TDefinition extends AdapterCommandDefinition<infer TRequest, unknown>
    ? TRequest
    : never;

export type AdapterCommandResult<TDefinition> =
  TDefinition extends AdapterCommandDefinition<unknown, infer TResult>
    ? TResult
    : never;

export interface AdapterExecutionContext {
  readonly traceId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly executionMode: "interruptible" | "synchronous-dom";
}

export interface AdapterCapability {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface AdapterCapabilities<TCommands extends object> {
  readonly protocolVersion: string;
  readonly commands: Readonly<
    Partial<Record<keyof TCommands & string, AdapterCapability>>
  >;
  readonly runtime: Readonly<Record<string, boolean | number | string>>;
}

/**
 * Host boundary for InDesign access. A protocol package supplies a command map,
 * so adding future commands does not require weakening the adapter to `any`.
 */
export interface InDesignAdapter<TCommands extends object> {
  probeCapabilities(
    context: AdapterExecutionContext,
  ): Promise<AdapterCapabilities<TCommands>>;

  execute<TCommand extends keyof TCommands & string>(
    command: TCommand,
    request: AdapterCommandRequest<TCommands[TCommand]>,
    context: AdapterExecutionContext,
  ): Promise<AdapterCommandResult<TCommands[TCommand]>>;

  dispose?(): Promise<void>;
}
