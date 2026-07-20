import {
  CommandError,
  CommandExampleValidationError,
  CommandMetadataError,
  CommandRegistryConflictError,
  CommandRegistryStateError,
} from './errors.js';
import { CommandParser } from './parser.js';
import type { CommandDescriptor, CommandRegistryView, CommandSource } from './types.js';

interface ClaimedName<TCommand extends CommandDescriptor> {
  command: TCommand;
  source: CommandSource;
}

export class CommandRegistry<TCommand extends CommandDescriptor = CommandDescriptor>
  implements CommandRegistryView<TCommand>
{
  private readonly commands: TCommand[] = [];
  private state: 'open' | 'sealed' = 'open';
  private index: ReadonlyMap<string, TCommand> = new Map();
  private visible: readonly TCommand[] = [];

  get size(): number {
    return this.commands.length;
  }

  isSealed(): boolean {
    return this.state === 'sealed';
  }

  registerBatch(commands: readonly TCommand[]): void {
    if (this.state !== 'open') {
      throw new CommandRegistryStateError('CommandRegistry 已 seal，不能继续注册命令。');
    }

    const claims = this.buildClaims(this.commands);
    for (const command of commands) {
      validateMetadata(command);
      for (const name of commandNames(command)) {
        const normalized = normalizeCommandName(name);
        const existing = claims.get(normalized);
        if (existing !== undefined) {
          throw new CommandRegistryConflictError(normalized, existing.source, command.metadata.source);
        }
        claims.set(normalized, { command, source: command.metadata.source });
      }
    }

    this.commands.push(...commands);
  }

  seal(): void {
    if (this.state === 'sealed') return;

    const claims = this.buildClaims(this.commands);
    this.index = new Map([...claims].map(([name, claim]) => [name, claim.command]));
    this.visible = this.commands.filter((command) => !command.metadata.hidden);
    this.state = 'sealed';

    try {
      this.validateExamples();
    } catch (error) {
      this.index = new Map();
      this.visible = [];
      this.state = 'open';
      throw error;
    }
  }

  lookup(name: string): TCommand | undefined {
    this.assertSealed();
    return this.index.get(normalizeCommandName(name));
  }

  listVisible(): readonly TCommand[] {
    this.assertSealed();
    return this.visible;
  }

  listAll(): readonly TCommand[] {
    this.assertSealed();
    return this.commands;
  }

  suggest(name: string, limit = 3): readonly TCommand[] {
    this.assertSealed();
    if (limit <= 0) return [];
    const query = normalizeCommandName(name);
    if (query.length === 0) return [];

    return this.visible
      .map((command, order) => ({ command, order, score: suggestionScore(query, command) }))
      .filter((candidate): candidate is { command: TCommand; order: number; score: number } => candidate.score !== undefined)
      .sort((left, right) => left.score - right.score || left.order - right.order)
      .slice(0, limit)
      .map((candidate) => candidate.command);
  }

  private assertSealed(): void {
    if (this.state !== 'sealed') {
      throw new CommandRegistryStateError('CommandRegistry 必须在查询前 seal。');
    }
  }

  private buildClaims(commands: readonly TCommand[]): Map<string, ClaimedName<TCommand>> {
    const claims = new Map<string, ClaimedName<TCommand>>();
    for (const command of commands) {
      for (const name of commandNames(command)) {
        const normalized = normalizeCommandName(name);
        const existing = claims.get(normalized);
        if (existing !== undefined) {
          throw new CommandRegistryConflictError(normalized, existing.source, command.metadata.source);
        }
        claims.set(normalized, { command, source: command.metadata.source });
      }
    }
    return claims;
  }

  private validateExamples(): void {
    const parser = new CommandParser(this);
    for (const command of this.commands) {
      for (const example of command.metadata.examples) {
        const result = parser.parse(example.invocation);
        if (result.kind !== 'command' || result.input.command !== command) {
          const detail = result.kind === 'error' ? result.error.message : `解析结果为 ${result.kind}`;
          throw new CommandExampleValidationError(command.metadata.name, example.invocation, detail);
        }
        if ('parseOperation' in command && typeof command.parseOperation === 'function') {
          const operation = command.parseOperation(result.input as never);
          if (operation instanceof CommandError) {
            throw new CommandExampleValidationError(command.metadata.name, example.invocation, operation.message);
          }
        }
      }
    }
  }
}

export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '').toLocaleLowerCase('en-US');
}

function validateMetadata(command: CommandDescriptor): void {
  const { metadata } = command;
  if (!isValidCommandName(metadata.name)) {
    throw new CommandMetadataError(`无效的 canonical command name：${metadata.name}`);
  }
  for (const alias of metadata.aliases) {
    if (!isValidCommandName(alias)) {
      throw new CommandMetadataError(`命令 /${metadata.name} 包含无效 alias：${alias}`);
    }
  }
  if (metadata.usage.length === 0) {
    throw new CommandMetadataError(`命令 /${metadata.name} 必须至少声明一条 usage。`);
  }
}

function isValidCommandName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]*$/u.test(name);
}

function commandNames(command: CommandDescriptor): readonly string[] {
  return [command.metadata.name, ...command.metadata.aliases];
}

function suggestionScore(query: string, command: CommandDescriptor): number | undefined {
  const names = commandNames(command).map(normalizeCommandName);
  let best: number | undefined;
  for (const name of names) {
    let score: number | undefined;
    if (name.startsWith(query) || query.startsWith(name)) {
      score = Math.abs(name.length - query.length);
    } else {
      const distance = levenshtein(query, name);
      const maximum = Math.max(query.length, name.length) <= 5 ? 1 : 2;
      if (distance <= maximum) score = 10 + distance;
    }
    if (score !== undefined && (best === undefined || score < best)) best = score;
  }
  return best;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(current[rightIndex - 1]! + 1, previous[rightIndex]! + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}
