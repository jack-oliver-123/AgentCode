import { describe, expect, it } from 'vitest';

import { AppRuntime } from '../../../src/app/runtime/AppRuntime.js';
import { createBuiltinCommandRegistry } from '../../../src/commands/builtins/index.js';
import { CommandContextBuilder } from '../../../src/commands/context.js';
import { CommandError } from '../../../src/commands/errors.js';
import { CommandParser } from '../../../src/commands/parser.js';
import type { CommandDefinition } from '../../../src/commands/types.js';

const EXPECTED_COMMANDS = ['help', 'compact', 'clear', 'plan', 'do', 'session', 'memory', 'permission', 'status', 'review', 'stop', 'steer', 'queue'];

function createParser(): CommandParser<CommandDefinition> {
  return new CommandParser(createBuiltinCommandRegistry());
}

async function context(active = false) {
  const runtime = new AppRuntime({
    mode: 'default',
    session: { id: 'session-a', createdAt: 1, updatedAt: 1, turnCount: 0, resumed: false, agentMode: 'default', selectedPermissionMode: 'normal', archivePath: 'a.jsonl' },
  });
  if (active) runtime.dispatch({ type: 'run.changed', run: { id: 'run-1', phase: 'streaming', reviewActive: false } });
  return new CommandContextBuilder({
    getAppSnapshot: runtime.getSnapshot,
    getSessionSnapshot: () => runtime.getSnapshot().session!,
    getPermissionSnapshot: () => runtime.getSnapshot().permissions,
    getMemorySnapshot: async () => ({ user: [], project: [], status: { autoNotesEnabled: false, counts: { user: 0, project: 0 }, indexPaths: { user: '', project: '' }, storagePaths: { user: '', project: '' } } }),
    getStatusSnapshot: async () => ({ ok: true }),
    createExecutionId: () => 'command-1',
  }).build();
}

function parseCommand(text: string) {
  const result = createParser().parse(text);
  if (result.kind !== 'command') throw new Error(`Expected command for ${text}, got ${result.kind}`);
  const operation = result.input.command.parseOperation(result.input);
  return { input: result.input, command: result.input.command, operation };
}

describe('built-in commands', () => {
  it('registers exactly 13 canonical commands and all specified aliases', () => {
    const registry = createBuiltinCommandRegistry();
    expect(registry.listVisible().map((command) => command.metadata.name)).toEqual(EXPECTED_COMMANDS);
    expect(registry.lookup('commands')?.metadata.name).toBe('help');
    expect(registry.lookup('summarize')?.metadata.name).toBe('compact');
    expect(registry.lookup('new')?.metadata.name).toBe('clear');
    expect(registry.lookup('default')?.metadata.name).toBe('do');
    expect(registry.lookup('resume')?.metadata.name).toBe('session');
    expect(registry.lookup('memories')?.metadata.name).toBe('memory');
    expect(registry.lookup('permissions')?.metadata.name).toBe('permission');
  });

  it('validates every declared example through parser and operation grammar while sealing', () => {
    expect(() => createBuiltinCommandRegistry()).not.toThrow();
  });

  it.each([
    ['/clear one two', 'clear'],
    ['/session resume', 'session'],
    ['/memory show invalid entry.md', 'memory'],
    ['/permission mode root', 'permission'],
    ['/review branch main --bad focus', 'review'],
    ['/steer', 'steer'],
    ['/queue remove zero', 'queue'],
  ])('returns authoritative usage for invalid grammar: %s', (text, commandName) => {
    const { operation } = parseCommand(text);
    expect(operation).toBeInstanceOf(CommandError);
    expect((operation as CommandError).usage).toEqual(createBuiltinCommandRegistry().lookup(commandName)?.metadata.usage);
  });

  it('makes /plan and /do mode-only without text, and preflightable mode+prompt actions with text', async () => {
    const noPrompt = parseCommand('/plan');
    const noPromptResult = noPrompt.command.handle(await context(), noPrompt.operation as never);
    expect(noPromptResult).toMatchObject({ kind: 'handled', actions: [{ type: 'set_agent_mode', mode: 'plan' }] });
    if (noPromptResult.kind !== 'handled') throw new Error('expected handled');
    expect(noPromptResult.actions).toHaveLength(1);

    const withPrompt = parseCommand('/default Implement This');
    const withPromptResult = withPrompt.command.handle(await context(), withPrompt.operation as never);
    expect(withPromptResult).toMatchObject({
      kind: 'handled',
      actions: [
        { type: 'set_agent_mode', mode: 'default' },
        { type: 'submit_prompt', text: 'Implement This', agentMode: 'default' },
      ],
    });
  });

  it('normalizes aliases to canonical operations without sending control syntax', async () => {
    const resume = parseCommand('/resume session-a');
    expect(resume.input.commandName).toBe('session');
    expect(resume.operation).toMatchObject({ kind: 'session.resume', target: 'session-a' });

    const summarize = parseCommand('/summarize keep APIs');
    expect(summarize.operation).toMatchObject({ kind: 'compact', instructions: 'keep APIs' });

    const next = parseCommand('/new "next task"');
    expect(next.operation).toMatchObject({ kind: 'clear', name: 'next task' });
  });

  it('parses deterministic queue and review subcommands', () => {
    expect(parseCommand('/queue add Run Regression Tests').operation).toMatchObject({ kind: 'queue.add', text: 'Run Regression Tests' });
    expect(parseCommand('/queue remove 2').operation).toMatchObject({ kind: 'queue.remove', index: 2 });
    expect(parseCommand('/review branch main --focus "security only"').operation).toMatchObject({ kind: 'review.branch', branch: 'main', focus: 'security only' });
    expect(parseCommand('/review pr https://github.com/acme/repo/pull/2').operation).toMatchObject({ kind: 'review.pr' });
  });

  it('rejects idle stop/steer without degrading them into prompts', async () => {
    for (const text of ['/stop', '/steer update the tests']) {
      const parsed = parseCommand(text);
      expect(parsed.command.handle(await context(false), parsed.operation as never)).toMatchObject({
        kind: 'rejected',
        error: { code: 'no_active_run' },
      });
    }
  });
});
