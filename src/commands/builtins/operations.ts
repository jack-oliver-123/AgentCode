import { CommandError } from '../errors.js';
import type {
  CommandDefinition,
  CommandOperation,
  CommandReadonlyPolicy,
  ParsedCommandInput,
} from '../types.js';

export type BuiltinOperation =
  | Operation<'help.open'>
  | (Operation<'help.detail'> & { command: string })
  | (Operation<'compact'> & { instructions?: string })
  | (Operation<'clear'> & { name?: string })
  | (Operation<'mode.plan'> & { prompt?: string })
  | (Operation<'mode.default'> & { prompt?: string })
  | Operation<'session.picker'>
  | Operation<'session.current'>
  | (Operation<'session.resume'> & { target: string })
  | (Operation<'session.rename'> & { name: string })
  | Operation<'memory.picker'>
  | Operation<'memory.status'>
  | (Operation<'memory.show'> & { scope: 'user' | 'project'; entry: string })
  | (Operation<'memory.delete'> & { scope: 'user' | 'project'; entry: string })
  | Operation<'permission.panel'>
  | Operation<'permission.status'>
  | (Operation<'permission.mode'> & { mode: 'strict' | 'normal' | 'auto' | 'yolo' })
  | (Operation<'permission.rules'> & { scope?: 'session' | 'project' | 'global' })
  | (Operation<'permission.remove'> & { scope: 'session' | 'project' | 'global'; ruleId: string })
  | Operation<'status.open'>
  | (Operation<'review.worktree'> & { focus?: string })
  | (Operation<'review.branch'> & { branch: string; focus?: string })
  | (Operation<'review.pr'> & { target: string; focus?: string })
  | Operation<'stop'>
  | (Operation<'steer'> & { text: string })
  | (Operation<'queue.add'> & { text: string })
  | Operation<'queue.list'>
  | Operation<'queue.run'>
  | (Operation<'queue.remove'> & { index: number })
  | Operation<'queue.clear'>;

type Operation<TKind extends string> = CommandOperation & {
  kind: TKind;
  activeRunPolicy: 'immediate' | 'reject';
  readonlyPolicy: CommandReadonlyPolicy;
};

export function parseBuiltinOperation(
  canonicalName: string,
  input: ParsedCommandInput<CommandDefinition>,
): BuiltinOperation | CommandError {
  switch (canonicalName) {
    case 'help':
      return input.argv.length === 0
        ? operation('help.open', 'immediate', 'allow')
        : input.argv.length === 1
          ? { ...operation('help.detail', 'immediate', 'allow'), command: normalizeCommandSelector(input.argv[0]!) }
          : invalid(input);
    case 'compact': {
      const instructions = optionalRaw(input);
      return {
        ...operation('compact', 'reject', 'reject'),
        ...(instructions !== undefined ? { instructions } : {}),
      };
    }
    case 'clear':
      return input.argv.length <= 1
        ? {
            ...operation('clear', 'reject', 'reject'),
            ...(input.argv[0] !== undefined ? { name: input.argv[0] } : {}),
          }
        : invalid(input);
    case 'plan': {
      const prompt = optionalRaw(input);
      return {
        ...operation('mode.plan', 'reject', 'control-write'),
        ...(prompt !== undefined ? { prompt } : {}),
      };
    }
    case 'do': {
      const prompt = optionalRaw(input);
      return {
        ...operation('mode.default', 'reject', 'control-write'),
        ...(prompt !== undefined ? { prompt } : {}),
      };
    }
    case 'session':
      return parseSession(input);
    case 'memory':
      return parseMemory(input);
    case 'permission':
      return parsePermission(input);
    case 'status':
      return operation('status.open', 'immediate', 'allow');
    case 'review':
      return parseReview(input);
    case 'stop':
      return operation('stop', 'immediate', 'allow');
    case 'steer':
      return optionalRaw(input) === undefined
        ? invalid(input)
        : { ...operation('steer', 'immediate', 'allow'), text: input.rawArguments };
    case 'queue':
      return parseQueue(input);
    default:
      return new CommandError('unknown_command', `Unknown built-in command: ${canonicalName}`);
  }
}

function parseSession(input: ParsedCommandInput<CommandDefinition>): BuiltinOperation | CommandError {
  if (input.invokedAs.toLocaleLowerCase() === 'resume') {
    if (input.argv.length === 0) return operation('session.picker', 'reject', 'reject');
    return input.argv.length === 1
      ? { ...operation('session.resume', 'reject', 'reject'), target: input.argv[0]! }
      : invalid(input);
  }
  if (input.argv.length === 0) return operation('session.picker', 'reject', 'reject');
  switch (input.argv[0]?.toLocaleLowerCase()) {
    case 'current':
      return input.argv.length === 1 ? operation('session.current', 'immediate', 'allow') : invalid(input);
    case 'resume':
      return input.argv.length === 2
        ? { ...operation('session.resume', 'reject', 'reject'), target: input.argv[1]! }
        : invalid(input);
    case 'rename':
      return input.argv.length === 2
        ? { ...operation('session.rename', 'immediate', 'control-write'), name: input.argv[1]! }
        : invalid(input);
    default:
      return invalid(input);
  }
}

function parseMemory(input: ParsedCommandInput<CommandDefinition>): BuiltinOperation | CommandError {
  if (input.argv.length === 0) return operation('memory.picker', 'immediate', 'allow');
  const subcommand = input.argv[0]?.toLocaleLowerCase();
  if (subcommand === 'status' && input.argv.length === 1) return operation('memory.status', 'immediate', 'allow');
  if ((subcommand === 'show' || subcommand === 'delete') && input.argv.length === 3) {
    const scope = parseMemoryScope(input.argv[1]!);
    if (scope === undefined) return invalid(input);
    return subcommand === 'show'
      ? { ...operation('memory.show', 'immediate', 'allow'), scope, entry: input.argv[2]! }
      : { ...operation('memory.delete', 'immediate', 'control-write'), scope, entry: input.argv[2]! };
  }
  return invalid(input);
}

function parsePermission(input: ParsedCommandInput<CommandDefinition>): BuiltinOperation | CommandError {
  if (input.argv.length === 0) return operation('permission.panel', 'immediate', 'allow');
  const subcommand = input.argv[0]?.toLocaleLowerCase();
  if (subcommand === 'status' && input.argv.length === 1) return operation('permission.status', 'immediate', 'allow');
  if (subcommand === 'mode' && input.argv.length === 2) {
    const mode = input.argv[1]?.toLocaleLowerCase();
    if (mode === 'strict' || mode === 'normal' || mode === 'auto' || mode === 'yolo') {
      return { ...operation('permission.mode', 'immediate', 'control-write'), mode };
    }
  }
  if (subcommand === 'rules' && input.argv.length <= 2) {
    const scope = input.argv[1] === undefined ? undefined : parsePermissionScope(input.argv[1]);
    if (input.argv[1] !== undefined && scope === undefined) return invalid(input);
    return {
      ...operation('permission.rules', 'immediate', 'allow'),
      ...(scope !== undefined ? { scope } : {}),
    };
  }
  if (subcommand === 'remove' && input.argv.length === 3) {
    const scope = parsePermissionScope(input.argv[1]!);
    if (scope !== undefined) {
      return {
        ...operation('permission.remove', 'immediate', 'control-write'),
        scope,
        ruleId: input.argv[2]!,
      };
    }
  }
  return invalid(input);
}

function parseReview(input: ParsedCommandInput<CommandDefinition>): BuiltinOperation | CommandError {
  if (input.argv.length === 0) return operation('review.worktree', 'reject', 'allow');
  if (input.argv[0] === '--focus' && input.argv.length === 2) {
    return { ...operation('review.worktree', 'reject', 'allow'), focus: input.argv[1]! };
  }
  const kind = input.argv[0]?.toLocaleLowerCase();
  if ((kind === 'branch' || kind === 'pr') && input.argv[1] !== undefined) {
    const focus = parseOptionalFocus(input.argv.slice(2));
    if (focus instanceof CommandError) return invalid(input);
    return kind === 'branch'
      ? {
          ...operation('review.branch', 'reject', 'allow'),
          branch: input.argv[1],
          ...(focus !== undefined ? { focus } : {}),
        }
      : {
          ...operation('review.pr', 'reject', 'allow'),
          target: input.argv[1],
          ...(focus !== undefined ? { focus } : {}),
        };
  }
  return invalid(input);
}

function parseQueue(input: ParsedCommandInput<CommandDefinition>): BuiltinOperation | CommandError {
  const subcommand = input.argv[0]?.toLocaleLowerCase();
  if (subcommand === 'add' && input.argv.length >= 2) {
    return { ...operation('queue.add', 'immediate', 'control-write'), text: input.argv.slice(1).join(' ') };
  }
  if (subcommand === 'list' && input.argv.length === 1) return operation('queue.list', 'immediate', 'allow');
  if (subcommand === 'run' && input.argv.length === 1) return operation('queue.run', 'reject', 'reject');
  if (subcommand === 'clear' && input.argv.length === 1) return operation('queue.clear', 'immediate', 'control-write');
  if (subcommand === 'remove' && input.argv.length === 2) {
    const index = Number(input.argv[1]);
    if (Number.isSafeInteger(index) && index > 0) {
      return { ...operation('queue.remove', 'immediate', 'control-write'), index };
    }
  }
  return invalid(input);
}

function operation<TKind extends BuiltinOperation['kind']>(
  kind: TKind,
  activeRunPolicy: 'immediate' | 'reject',
  readonlyPolicy: CommandReadonlyPolicy,
): Operation<TKind> {
  return { kind, activeRunPolicy, readonlyPolicy };
}

function invalid(input: ParsedCommandInput<CommandDefinition>): CommandError {
  return new CommandError('invalid_arguments', `Invalid arguments for /${input.commandName}.`, {
    usage: input.command.metadata.usage,
  });
}

function optionalRaw(input: ParsedCommandInput<CommandDefinition>): string | undefined {
  return input.rawArguments.length === 0 ? undefined : input.rawArguments;
}

function normalizeCommandSelector(value: string): string {
  return value.replace(/^\/+/, '').toLocaleLowerCase();
}

function parseMemoryScope(value: string): 'user' | 'project' | undefined {
  const normalized = value.toLocaleLowerCase();
  return normalized === 'user' || normalized === 'project' ? normalized : undefined;
}

function parsePermissionScope(value: string): 'session' | 'project' | 'global' | undefined {
  const normalized = value.toLocaleLowerCase();
  return normalized === 'session' || normalized === 'project' || normalized === 'global' ? normalized : undefined;
}

function parseOptionalFocus(argv: readonly string[]): string | undefined | CommandError {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === '--focus') return argv[1]!;
  return new CommandError('invalid_arguments', 'Invalid --focus arguments.');
}
