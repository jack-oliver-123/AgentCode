import { describe, expect, it } from 'vitest';

import { CommandError } from '../../../src/commands/errors.js';
import { CommandParser } from '../../../src/commands/parser.js';
import { CommandRegistry } from '../../../src/commands/registry.js';
import type { CommandDescriptor, CommandMetadata } from '../../../src/commands/types.js';

function command(
  name: string,
  overrides: Partial<CommandMetadata> = {},
): CommandDescriptor {
  return {
    metadata: {
      name,
      aliases: [],
      summary: `${name} command`,
      category: 'general',
      argumentMode: 'argv',
      usage: [`/${name}`],
      examples: [{ invocation: `/${name}`, description: 'example' }],
      execution: 'local',
      effects: [],
      activeRunPolicy: 'immediate',
      hidden: false,
      userInvocable: true,
      source: { type: 'builtin' },
      ...overrides,
    },
  };
}

function createParser(): CommandParser {
  const registry = new CommandRegistry();
  registry.registerBatch([
    command('plan', {
      aliases: ['outline'],
      argumentMode: 'raw',
      usage: ['/plan [text]'],
      examples: [{ invocation: '/plan Keep Existing Case', description: 'plan a task' }],
    }),
    command('status', { argumentMode: 'none', usage: ['/status'] }),
    command('session'),
    command('secret', { hidden: true }),
    command('internal', { hidden: true, userInvocable: false, examples: [] }),
  ]);
  registry.seal();
  return new CommandParser(registry);
}

describe('CommandParser', () => {
  it('distinguishes empty, ordinary text, and bare slash without consuming bare slash', () => {
    const parser = createParser();

    expect(parser.parse('   ')).toEqual({ kind: 'empty', consumed: false });
    expect(parser.parse('  hello world  ')).toEqual({
      kind: 'text',
      text: 'hello world',
      consumed: false,
    });
    expect(parser.parse(' / ')).toEqual({ kind: 'completion', query: '/', consumed: false });
  });

  it('resolves canonical names and aliases case-insensitively while preserving arguments', () => {
    const parser = createParser();

    const canonical = parser.parse('  /PLAN   Keep Existing Case  ');
    expect(canonical).toMatchObject({
      kind: 'command',
      consumed: true,
      input: {
        raw: '/PLAN   Keep Existing Case',
        commandName: 'plan',
        invokedAs: 'PLAN',
        rawArguments: 'Keep Existing Case',
        argv: ['Keep', 'Existing', 'Case'],
      },
    });

    const alias = parser.parse('/OuTlInE same CASE');
    expect(alias).toMatchObject({
      kind: 'command',
      input: {
        commandName: 'plan',
        invokedAs: 'OuTlInE',
        rawArguments: 'same CASE',
      },
    });
  });

  it('uses deterministic quoting and escaping rules on every platform', () => {
    const parser = createParser();
    const result = parser.parse(
      String.raw`/session one "two three" 'C:\path\file' four\ five C:\temp "line\nnext" "quote: \""`,
    );

    expect(result).toMatchObject({
      kind: 'command',
      input: {
        argv: ['one', 'two three', String.raw`C:\path\file`, 'four five', String.raw`C:\temp`, 'line\nnext', 'quote: "'],
      },
    });
  });

  it('keeps unknown escapes outside quotes but rejects them inside double quotes', () => {
    const parser = createParser();

    expect(parser.parse(String.raw`/session C:\path\file`)).toMatchObject({
      kind: 'command',
      input: { argv: [String.raw`C:\path\file`] },
    });

    const invalid = parser.parse(String.raw`/session "C:\path\file"`);
    expect(invalid).toMatchObject({
      kind: 'error',
      consumed: false,
      error: { code: 'invalid_escape' },
    });
  });

  it('reports an exact position for an unclosed quote and preserves the input', () => {
    const parser = createParser();
    const result = parser.parse('/session "unfinished');

    expect(result).toMatchObject({
      kind: 'error',
      consumed: false,
      error: { code: 'unclosed_quote', position: 9 },
    });
  });

  it('rejects extra arguments for commands declaring argumentMode=none', () => {
    const parser = createParser();
    const result = parser.parse('/status now');

    expect(result).toMatchObject({
      kind: 'error',
      consumed: false,
      error: { code: 'invalid_arguments', usage: ['/status'] },
    });
  });

  it('never executes an unknown prefix and returns conservative visible suggestions', () => {
    const parser = createParser();
    const result = parser.parse('/sta');

    expect(result).toMatchObject({
      kind: 'error',
      consumed: false,
      error: {
        code: 'unknown_command',
        suggestions: ['status'],
      },
    });
    if (result.kind !== 'error') throw new Error('expected an error');
    expect(result.error.message).toContain('/help');
  });

  it('does not normalize an extra slash into an executable command', () => {
    const parser = createParser();
    const result = parser.parse('//status');

    expect(result).toMatchObject({ kind: 'error', consumed: false, error: { code: 'unknown_command' } });
  });

  it('allows exact hidden commands when userInvocable is true but rejects internal commands', () => {
    const parser = createParser();

    expect(parser.parse('/secret')).toMatchObject({ kind: 'command' });
    const internal = parser.parse('/internal');
    expect(internal).toMatchObject({
      kind: 'error',
      error: { code: 'not_user_invocable' },
    });
    if (internal.kind !== 'error') throw new Error('expected an error');
    expect(internal.error).toBeInstanceOf(CommandError);
  });
});
