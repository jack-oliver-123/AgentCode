import type { CommandContext, CommandContextBuilder } from './context.js';
import { CommandError } from './errors.js';
import type {
  CommandAction,
  CommandDefinition,
  CommandDispatchResult,
  CommandOperation,
  CommandResult,
  ParsedCommandInput,
} from './types.js';

export interface CommandActionExecutor {
  preflight(action: CommandAction, context: CommandContext, operation: CommandOperation): Promise<void>;
  commit(action: CommandAction, context: CommandContext, operation: CommandOperation): Promise<unknown>;
}

export interface CommandDispatcherOptions {
  contextBuilder: CommandContextBuilder;
  executor: CommandActionExecutor;
}

export class CommandDispatcher {
  private readonly committedActions = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CommandDispatcherOptions) {}

  async dispatch(input: ParsedCommandInput<CommandDefinition>): Promise<CommandDispatchResult> {
    let operation: CommandOperation | CommandError;
    try {
      operation = input.command.parseOperation(input);
    } catch (error) {
      return {
        kind: 'rejected',
        consumed: false,
        error: commandError('invalid_arguments', error, input.command.metadata.usage),
      };
    }
    if (operation instanceof CommandError) return { kind: 'rejected', consumed: false, error: operation };
    return this.dispatchOperation(input.command, operation);
  }

  async dispatchOperation(
    command: CommandDefinition,
    operation: CommandOperation,
  ): Promise<CommandDispatchResult> {
    let context: CommandContext;
    try {
      context = await this.options.contextBuilder.build(operation);
    } catch (error) {
      return { kind: 'rejected', consumed: false, error: commandError('preflight_failed', error) };
    }

    const policyError = validateOperationPolicy(command, operation, context);
    if (policyError !== undefined) return { kind: 'rejected', consumed: false, error: policyError };

    let result: CommandResult;
    try {
      result = command.handle(context, operation);
    } catch (error) {
      return { kind: 'rejected', consumed: false, error: commandError('internal_error', error) };
    }
    if (result.kind === 'rejected') return { kind: 'rejected', consumed: false, error: result.error };

    try {
      for (const action of result.actions) {
        await this.options.executor.preflight(action, context, operation);
      }
    } catch (error) {
      return { kind: 'rejected', consumed: false, error: commandError('preflight_failed', error) };
    }

    const completed: string[] = [];
    for (let index = 0; index < result.actions.length; index += 1) {
      const action = result.actions[index]!;
      try {
        await this.commitOnce(action, context, operation);
        completed.push(action.idempotencyKey);
      } catch (error) {
        return {
          kind: 'failed',
          consumed: completed.length > 0,
          completed,
          pending: result.actions.slice(index + 1).map((pending) => pending.idempotencyKey),
          error: commandError('commit_failed', error),
        };
      }
    }
    return { kind: 'completed', consumed: true, completed };
  }

  private commitOnce(action: CommandAction, context: CommandContext, operation: CommandOperation): Promise<unknown> {
    const existing = this.committedActions.get(action.idempotencyKey);
    if (existing !== undefined) return existing;
    const committed = this.options.executor.commit(action, context, operation);
    this.committedActions.set(action.idempotencyKey, committed);
    void committed.catch(() => {
      if (this.committedActions.get(action.idempotencyKey) === committed) {
        this.committedActions.delete(action.idempotencyKey);
      }
    });
    return committed;
  }
}

function validateOperationPolicy(
  command: CommandDefinition,
  operation: CommandOperation,
  context: CommandContext,
): CommandError | undefined {
  const activeRunPolicy = operation.activeRunPolicy ?? command.metadata.activeRunPolicy;
  const activeRun = context.app.run.phase !== 'idle' || context.app.queue.draining;
  if (activeRun && activeRunPolicy === 'reject') {
    return new CommandError('active_run_rejected', `Operation ${operation.kind} is unavailable while a run is active.`);
  }

  const readonly = context.app.mode === 'plan' || context.app.run.reviewActive;
  const readonlyPolicy = operation.readonlyPolicy ?? 'reject';
  if (readonly && readonlyPolicy === 'reject') {
    return new CommandError('readonly_rejected', `Operation ${operation.kind} is blocked by the current readonly mode.`);
  }
  return undefined;
}

function commandError(
  code: ConstructorParameters<typeof CommandError>[0],
  error: unknown,
  usage?: readonly string[],
): CommandError {
  const message = error instanceof Error ? error.message : String(error);
  return new CommandError(code, message, usage === undefined ? {} : { usage });
}
