import { CommandError } from './errors.js';
import type {
  ArgumentTokenizationResult,
  CommandDescriptor,
  CommandParseResult,
  CommandRegistryView,
} from './types.js';

export class CommandParser<TCommand extends CommandDescriptor = CommandDescriptor> {
  constructor(private readonly registry: CommandRegistryView<TCommand>) {}

  parse(rawInput: string): CommandParseResult<TCommand> {
    return parseCommandInput(rawInput, this.registry);
  }
}

export function parseCommandInput<TCommand extends CommandDescriptor>(
  rawInput: string,
  registry: CommandRegistryView<TCommand>,
): CommandParseResult<TCommand> {
  const raw = rawInput.trim();
  if (raw.length === 0) return { kind: 'empty', consumed: false };
  if (!raw.startsWith('/')) return { kind: 'text', text: raw, consumed: false };
  if (raw === '/') return { kind: 'completion', query: '/', consumed: false };

  const nameEnd = findNameEnd(raw);
  const invokedAs = raw.slice(1, nameEnd);
  const argumentStart = findArgumentStart(raw, nameEnd);
  const rawArguments = raw.slice(argumentStart);
  const command = /^[A-Za-z][A-Za-z0-9-]*$/u.test(invokedAs) ? registry.lookup(invokedAs) : undefined;

  if (command === undefined) {
    const suggestions = registry.suggest(invokedAs, 3).map((candidate) => candidate.metadata.name);
    const suggestionText = suggestions.length === 0 ? '' : ` 你是否想使用：${suggestions.map((name) => `/${name}`).join('、')}？`;
    return {
      kind: 'error',
      consumed: false,
      error: new CommandError(
        'unknown_command',
        `未知命令 /${invokedAs}。${suggestionText}使用 /help 查看可用命令。`,
        { suggestions },
      ),
    };
  }

  if (!command.metadata.userInvocable) {
    return {
      kind: 'error',
      consumed: false,
      error: new CommandError('not_user_invocable', `命令 /${command.metadata.name} 不能由用户直接调用。`),
    };
  }

  const tokenized = tokenizeCommandArguments(rawArguments, argumentStart);
  if (!tokenized.ok) {
    return { kind: 'error', consumed: false, error: tokenized.error };
  }

  if (command.metadata.argumentMode === 'none' && tokenized.argv.length > 0) {
    return {
      kind: 'error',
      consumed: false,
      error: new CommandError('invalid_arguments', `命令 /${command.metadata.name} 不接受参数。`, {
        usage: command.metadata.usage,
      }),
    };
  }

  return {
    kind: 'command',
    consumed: true,
    input: {
      raw,
      commandName: command.metadata.name,
      invokedAs,
      rawArguments,
      argv: tokenized.argv,
      command,
    },
  };
}

export function tokenizeCommandArguments(rawArguments: string, positionOffset = 0): ArgumentTokenizationResult {
  const argv: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: 'single' | 'double' | undefined;
  let quoteStart = -1;

  for (let index = 0; index < rawArguments.length; index += 1) {
    const character = rawArguments[index]!;

    if (quote === 'single') {
      if (character === "'") {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (quote === 'double') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === '\\') {
        const escaped = rawArguments[index + 1];
        if (escaped === undefined) {
          return invalidEscape(positionOffset + index, '双引号中的反斜杠后缺少转义字符。');
        }
        const replacement = doubleQuotedEscape(escaped);
        if (replacement === undefined) {
          return invalidEscape(positionOffset + index, `双引号中不支持转义 \\${escaped}。`);
        }
        current += replacement;
        index += 1;
        continue;
      }
      current += character;
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        argv.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character === "'" ? 'single' : 'double';
      quoteStart = index;
      tokenStarted = true;
      continue;
    }

    if (character === '\\') {
      const escaped = rawArguments[index + 1];
      if (escaped === undefined) {
        current += '\\';
        tokenStarted = true;
        continue;
      }
      if (/\s/u.test(escaped) || escaped === "'" || escaped === '"' || escaped === '\\') {
        current += escaped;
      } else {
        current += `\\${escaped}`;
      }
      tokenStarted = true;
      index += 1;
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (quote !== undefined) {
    return {
      ok: false,
      error: new CommandError('unclosed_quote', '命令参数包含未闭合的引号。', {
        position: positionOffset + quoteStart,
      }),
    };
  }

  if (tokenStarted) argv.push(current);
  return { ok: true, argv };
}

function findNameEnd(raw: string): number {
  for (let index = 1; index < raw.length; index += 1) {
    if (/\s/u.test(raw[index]!)) return index;
  }
  return raw.length;
}

function findArgumentStart(raw: string, nameEnd: number): number {
  let index = nameEnd;
  while (index < raw.length && /\s/u.test(raw[index]!)) index += 1;
  return index;
}

function invalidEscape(position: number, message: string): ArgumentTokenizationResult {
  return {
    ok: false,
    error: new CommandError('invalid_escape', message, { position }),
  };
}

function doubleQuotedEscape(character: string): string | undefined {
  switch (character) {
    case '"':
      return '"';
    case '\\':
      return '\\';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return undefined;
  }
}
