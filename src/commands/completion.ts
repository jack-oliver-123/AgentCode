import type { CompletionResult } from '../app/runtime/InputRouter.js';
import type { MemoryIndexSnapshot } from '../app/memory/MemoryManager.js';
import type { PermissionRuleView } from '../app/permissions/PermissionManager.js';
import type { WorkspaceSessionSummary } from '../app/session/SessionWorkspace.js';
import type { CommandDefinition, CommandRegistryView } from './types.js';

export interface CommandCompletionSources {
  sessions: () => readonly WorkspaceSessionSummary[];
  memory: () => MemoryIndexSnapshot;
  permissionRules: () => readonly PermissionRuleView[];
}

const STATIC_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  session: ['current', 'resume', 'rename'],
  memory: ['status', 'show', 'delete'],
  permission: ['status', 'mode', 'rules', 'remove'],
  review: ['branch', 'pr', '--focus'],
  queue: ['add', 'list', 'run', 'remove', 'clear'],
};

export class CommandCompletionService {
  private cycle: {
    seed: string;
    rendered: string;
    candidates: readonly string[];
    index: number;
  } | undefined;

  constructor(
    private readonly registry: CommandRegistryView<CommandDefinition>,
    private readonly sources: CommandCompletionSources,
  ) {}

  reset(): void {
    this.cycle = undefined;
  }

  complete(text: string, direction: 'next' | 'previous'): CompletionResult {
    if (this.cycle !== undefined && this.cycle.index >= 0 && text === this.cycle.rendered) {
      const candidates = this.cycle.candidates;
      const delta = direction === 'next' ? 1 : -1;
      const index = (this.cycle.index + delta + candidates.length) % candidates.length;
      const rendered = applyCompletion(this.cycle.seed, candidates[index]!);
      this.cycle = { ...this.cycle, rendered, index };
      return { text: rendered, candidates, direction, selectedIndex: index };
    }
    const candidates = this.candidates(text);
    if (candidates.length === 0) {
      this.cycle = undefined;
      return { text, candidates, direction };
    }
    if (candidates.length === 1) {
      this.cycle = undefined;
      return { text: applyCompletion(text, candidates[0]!), candidates, direction, selectedIndex: 0 };
    }

    const cycle = this.cycle;
    if (
      cycle === undefined ||
      (text !== cycle.seed && text !== cycle.rendered) ||
      !sameCandidates(cycle.candidates, candidates)
    ) {
      this.cycle = { seed: text, rendered: text, candidates, index: -1 };
      return { text, candidates, direction };
    }

    const delta = direction === 'next' ? 1 : -1;
    const index = cycle.index < 0
      ? direction === 'next' ? 0 : candidates.length - 1
      : (cycle.index + delta + candidates.length) % candidates.length;
    const rendered = applyCompletion(cycle.seed, candidates[index]!);
    this.cycle = { ...cycle, rendered, index };
    return { text: rendered, candidates, direction, selectedIndex: index };
  }

  candidates(text: string): readonly string[] {
    const trimmedStart = text.trimStart();
    if (!trimmedStart.startsWith('/')) return [];
    const hasTrailingSpace = /\s$/u.test(trimmedStart);
    const tokens = trimmedStart.trimEnd().split(/\s+/u);
    const commandToken = tokens[0]!.slice(1).toLocaleLowerCase();
    const command = this.registry.lookup(commandToken);

    if (tokens.length === 1 && !hasTrailingSpace) {
      return this.registry
        .listVisible()
        .filter((candidate) => matchesCommand(candidate, commandToken))
        .map((candidate) => `/${candidate.metadata.name}`);
    }
    if (command === undefined) return [];

    const args = tokens.slice(1);
    const activeIndex = hasTrailingSpace ? args.length : Math.max(0, args.length - 1);
    const query = hasTrailingSpace ? '' : (args.at(-1) ?? '').toLocaleLowerCase();
    const values = this.argumentCandidates(command.metadata.name, commandToken, args, activeIndex);
    return values.filter((candidate) => candidate.toLocaleLowerCase().includes(query));
  }

  private argumentCandidates(
    command: string,
    invokedAs: string,
    args: readonly string[],
    index: number,
  ): readonly string[] {
    if (command === 'help' && index === 0) return this.registry.listVisible().map((item) => item.metadata.name);
    if (command === 'session') {
      if (invokedAs === 'resume' && index === 0) return sessionCandidates(this.sources.sessions());
      if (index === 0) return STATIC_SUBCOMMANDS['session']!;
      if (args[0]?.toLocaleLowerCase() === 'resume' && index === 1) {
        return sessionCandidates(this.sources.sessions());
      }
    }
    if (command === 'memory') {
      if (index === 0) return STATIC_SUBCOMMANDS['memory']!;
      const subcommand = args[0]?.toLocaleLowerCase();
      if ((subcommand === 'show' || subcommand === 'delete') && index === 1) return ['user', 'project'];
      if ((subcommand === 'show' || subcommand === 'delete') && index === 2) {
        const scope = args[1]?.toLocaleLowerCase();
        return scope === 'user'
          ? this.sources.memory().user.map((entry) => entry.filename)
          : scope === 'project'
            ? this.sources.memory().project.map((entry) => entry.filename)
            : [];
      }
    }
    if (command === 'permission') {
      if (index === 0) return STATIC_SUBCOMMANDS['permission']!;
      const subcommand = args[0]?.toLocaleLowerCase();
      if (subcommand === 'mode' && index === 1) return ['strict', 'normal', 'auto', 'yolo'];
      if ((subcommand === 'rules' || subcommand === 'remove') && index === 1) return ['session', 'project', 'global'];
      if (subcommand === 'remove' && index === 2) {
        const scope = args[1]?.toLocaleLowerCase();
        return this.sources.permissionRules().filter((rule) => rule.scope === scope).map((rule) => rule.id);
      }
    }
    return index === 0 ? (STATIC_SUBCOMMANDS[command] ?? []) : [];
  }
}

function matchesCommand(command: CommandDefinition, query: string): boolean {
  if (query.length === 0) return true;
  const metadata = command.metadata;
  return [metadata.name, ...metadata.aliases, metadata.summary, metadata.argumentHint ?? '']
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function applyCompletion(text: string, candidate: string): string {
  const trailing = /\s$/u.test(text);
  const tokens = text.trimEnd().split(/\s+/u);
  if (tokens.length === 1) return `${candidate} `;
  tokens[tokens.length - 1] = candidate;
  return `${tokens.join(' ')}${trailing ? ' ' : ' '}`;
}

function sameCandidates(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((candidate, index) => candidate === right[index]);
}

function sessionCandidates(sessions: readonly WorkspaceSessionSummary[]): string[] {
  return sessions.flatMap((session) =>
    session.name === undefined ? [session.id] : [session.id, quoteCommandArgument(session.name)],
  );
}

function quoteCommandArgument(value: string): string {
  if (!/[\s"'\\]/u.test(value)) return value;
  return `"${value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
    .replace(/\t/gu, '\\t')}"`;
}
