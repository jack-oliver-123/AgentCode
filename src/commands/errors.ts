import type { CommandSource } from './types.js';

export type CommandErrorCode =
  | 'unknown_command'
  | 'not_user_invocable'
  | 'invalid_arguments'
  | 'unclosed_quote'
  | 'invalid_escape'
  | 'active_run_rejected'
  | 'readonly_rejected'
  | 'preflight_failed'
  | 'commit_failed'
  | 'no_active_run'
  | 'target_changed'
  | 'internal_error';

export interface CommandErrorOptions {
  usage?: readonly string[];
  suggestions?: readonly string[];
  position?: number;
}

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly usage: readonly string[] | undefined;
  readonly suggestions: readonly string[];
  readonly position: number | undefined;

  constructor(code: CommandErrorCode, message: string, options: CommandErrorOptions = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.usage = options.usage;
    this.suggestions = options.suggestions ?? [];
    this.position = options.position;
  }
}

export class CommandStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandStartupError';
  }
}

export class CommandRegistryConflictError extends CommandStartupError {
  readonly conflictingName: string;
  readonly firstSource: CommandSource;
  readonly secondSource: CommandSource;

  constructor(conflictingName: string, firstSource: CommandSource, secondSource: CommandSource) {
    super(
      `命令名称冲突 "${conflictingName}"：${formatCommandSource(firstSource)} 与 ${formatCommandSource(secondSource)}`,
    );
    this.name = 'CommandRegistryConflictError';
    this.conflictingName = conflictingName;
    this.firstSource = firstSource;
    this.secondSource = secondSource;
  }
}

export class CommandRegistryStateError extends CommandStartupError {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRegistryStateError';
  }
}

export class CommandMetadataError extends CommandStartupError {
  constructor(message: string) {
    super(message);
    this.name = 'CommandMetadataError';
  }
}

export class CommandExampleValidationError extends CommandStartupError {
  readonly commandName: string;
  readonly invocation: string;

  constructor(commandName: string, invocation: string, detail: string) {
    super(`命令 /${commandName} 的示例无法通过真实解析器：${invocation}（${detail}）`);
    this.name = 'CommandExampleValidationError';
    this.commandName = commandName;
    this.invocation = invocation;
  }
}

export function formatCommandSource(source: CommandSource): string {
  if (source.type === 'builtin') return 'builtin';
  const namespace = source.namespace === undefined ? '' : `@${source.namespace}`;
  return `${source.type}:${source.id}${namespace}`;
}
