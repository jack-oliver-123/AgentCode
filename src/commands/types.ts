export type CommandCategory =
  | 'general'
  | 'conversation'
  | 'mode'
  | 'workspace'
  | 'workflow'
  | 'runtime';

export type CommandArgumentMode = 'none' | 'raw' | 'argv';
export type CommandExecutionMechanism = 'local' | 'prompt' | 'hybrid';
export type CommandEffect = 'ui' | 'session' | 'mode' | 'config' | 'model';
export type ActiveRunPolicy = 'immediate' | 'queue' | 'reject';

export type CommandSource =
  | { type: 'builtin' }
  | { type: 'skill'; id: string; namespace?: string }
  | { type: 'plugin'; id: string; namespace: string };

export interface CommandExample {
  invocation: string;
  description: string;
}

export interface CommandMetadata {
  name: string;
  aliases: readonly string[];
  summary: string;
  category: CommandCategory;
  argumentMode: CommandArgumentMode;
  usage: readonly string[];
  examples: readonly CommandExample[];
  argumentHint?: string;
  execution: CommandExecutionMechanism;
  effects: readonly CommandEffect[];
  activeRunPolicy: ActiveRunPolicy;
  hidden: boolean;
  userInvocable: boolean;
  source: CommandSource;
}

/** Registry stores command objects, while only depending on their discovery metadata. */
export interface CommandDescriptor {
  metadata: CommandMetadata;
}

export type CommandReadonlyPolicy = 'allow' | 'control-write' | 'reject';

export interface CommandOperation {
  kind: string;
  activeRunPolicy?: ActiveRunPolicy;
  readonlyPolicy?: CommandReadonlyPolicy;
}

interface CommandActionBase {
  idempotencyKey: string;
}

export type CommandAction =
  | (CommandActionBase & { type: 'show_notice'; level: 'info' | 'warn' | 'error'; text: string; ttlMs?: number })
  | (CommandActionBase & { type: 'append_command_output'; command: string; content: string })
  | (CommandActionBase & { type: 'open_panel'; panel: import('../app/runtime/types.js').PanelDescriptor })
  | (CommandActionBase & {
      type: 'open_interaction';
      request: import('../app/interaction/InteractionCoordinator.js').NewInteractionRequest;
    })
  | (CommandActionBase & { type: 'set_agent_mode'; mode: import('../app/runtime/types.js').AgentMode })
  | (CommandActionBase & {
      type: 'submit_prompt';
      text: string;
      agentMode: import('../app/runtime/types.js').AgentMode;
    })
  | (CommandActionBase & { type: 'compact'; instructions?: string })
  | (CommandActionBase & { type: 'create_session'; name?: string })
  | (CommandActionBase & { type: 'activate_session'; sessionId: string })
  | (CommandActionBase & { type: 'rename_session'; sessionId: string; name: string })
  | (CommandActionBase & { type: 'show_memory'; scope: 'user' | 'project'; entry: string })
  | (CommandActionBase & { type: 'request_memory_delete'; scope: 'user' | 'project'; entry: string })
  | (CommandActionBase & {
      type: 'delete_memory';
      target: import('../app/memory/MemoryManager.js').MemoryDeleteTarget;
    })
  | (CommandActionBase & {
      type: 'set_permission_mode';
      mode: import('../app/runtime/types.js').PermissionMode;
      confirmed?: boolean;
    })
  | (CommandActionBase & {
      type: 'remove_permission_rule';
      scope: import('../app/permissions/PermissionManager.js').PermissionScope;
      ruleId: string;
      expectedGeneration: number;
    })
  | (CommandActionBase & {
      type: 'request_permission_rule_remove';
      scope: import('../app/permissions/PermissionManager.js').PermissionScope;
      ruleId: string;
      expectedGeneration: number;
      expectedFingerprint: string;
    })
  | (CommandActionBase & {
      type: 'start_review';
      target: import('../app/review/targetFreeze.js').ReviewTargetInput;
    })
  | (CommandActionBase & { type: 'queue_add'; text: string })
  | (CommandActionBase & { type: 'queue_run' })
  | (CommandActionBase & { type: 'queue_remove'; index: number; expectedVersion?: number })
  | (CommandActionBase & { type: 'queue_clear'; expectedVersion?: number })
  | (CommandActionBase & { type: 'request_queue_remove'; index: number; expectedVersion: number })
  | (CommandActionBase & { type: 'request_queue_clear'; expectedVersion: number })
  | (CommandActionBase & { type: 'steer'; text: string })
  | (CommandActionBase & { type: 'stop_run' });

export type CommandResult =
  | { kind: 'handled'; actions: readonly CommandAction[] }
  | { kind: 'rejected'; error: import('./errors.js').CommandError };

export interface CommandDefinition<TOperation extends CommandOperation = CommandOperation> extends CommandDescriptor {
  parseOperation(input: ParsedCommandInput<CommandDefinition<TOperation>>): TOperation | import('./errors.js').CommandError;
  handle(context: import('./context.js').CommandContext, operation: TOperation): CommandResult;
}

export type CommandDispatchResult =
  | { kind: 'completed'; consumed: true; completed: readonly string[] }
  | { kind: 'rejected'; consumed: false; error: import('./errors.js').CommandError }
  | {
      kind: 'failed';
      consumed: boolean;
      completed: readonly string[];
      pending: readonly string[];
      error: import('./errors.js').CommandError;
    };

export interface CommandRegistryView<TCommand extends CommandDescriptor = CommandDescriptor> {
  isSealed(): boolean;
  lookup(name: string): TCommand | undefined;
  listVisible(): readonly TCommand[];
  suggest(name: string, limit?: number): readonly TCommand[];
}

export interface ParsedCommandInput<TCommand extends CommandDescriptor = CommandDescriptor> {
  raw: string;
  commandName: string;
  invokedAs: string;
  rawArguments: string;
  argv: readonly string[];
  command: TCommand;
}

export type CommandParseResult<TCommand extends CommandDescriptor = CommandDescriptor> =
  | { kind: 'empty'; consumed: false }
  | { kind: 'text'; text: string; consumed: false }
  | { kind: 'completion'; query: '/'; consumed: false }
  | { kind: 'command'; input: ParsedCommandInput<TCommand>; consumed: true }
  | { kind: 'error'; error: import('./errors.js').CommandError; consumed: false };

export type ArgumentTokenizationResult =
  | { ok: true; argv: readonly string[] }
  | { ok: false; error: import('./errors.js').CommandError };
