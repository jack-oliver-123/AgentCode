import { describe, expect, it } from 'vitest';

import {
  CommandExampleValidationError,
  CommandRegistryConflictError,
  CommandRegistryStateError,
} from '../../../src/commands/errors.js';
import { CommandRegistry } from '../../../src/commands/registry.js';
import type { CommandDescriptor, CommandMetadata, CommandSource } from '../../../src/commands/types.js';

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
      argumentMode: 'none',
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

describe('CommandRegistry', () => {
  it('registers a batch, seals it, and resolves canonical names and aliases case-insensitively', () => {
    const registry = new CommandRegistry();
    registry.registerBatch([
      command('help', { aliases: ['commands'] }),
      command('status'),
    ]);

    expect(registry.isSealed()).toBe(false);
    registry.seal();

    expect(registry.isSealed()).toBe(true);
    expect(registry.lookup('HELP')?.metadata.name).toBe('help');
    expect(registry.lookup('/Commands')?.metadata.name).toBe('help');
    expect(registry.listVisible().map((item) => item.metadata.name)).toEqual(['help', 'status']);
  });

  it('keeps hidden commands callable by exact lookup while excluding them from discovery', () => {
    const registry = new CommandRegistry();
    registry.registerBatch([
      command('visible'),
      command('hidden', { hidden: true }),
    ]);
    registry.seal();

    expect(registry.lookup('hidden')?.metadata.userInvocable).toBe(true);
    expect(registry.listVisible().map((item) => item.metadata.name)).toEqual(['visible']);
    expect(registry.suggest('hid')).toEqual([]);
  });

  it('preserves source and namespace metadata for future extension isolation', () => {
    const source: CommandSource = { type: 'plugin', id: 'example', namespace: 'acme' };
    const registry = new CommandRegistry();
    registry.registerBatch([command('inspect', { source })]);
    registry.seal();

    expect(registry.lookup('inspect')?.metadata.source).toEqual(source);
  });

  it('rejects canonical/alias conflicts atomically and identifies both sources', () => {
    const registry = new CommandRegistry();
    const builtin = command('help', { aliases: ['commands'] });
    const plugin = command('commands', {
      source: { type: 'plugin', id: 'docs', namespace: 'example' },
    });

    let thrown: unknown;
    try {
      registry.registerBatch([builtin, plugin]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CommandRegistryConflictError);
    expect(thrown).toMatchObject({
      conflictingName: 'commands',
      firstSource: { type: 'builtin' },
      secondSource: { type: 'plugin', id: 'docs', namespace: 'example' },
    });
    expect((thrown as Error).message).toContain('builtin');
    expect((thrown as Error).message).toContain('plugin:docs');
    expect(registry.size).toBe(0);
  });

  it('does not allow registration after seal', () => {
    const registry = new CommandRegistry();
    registry.registerBatch([command('help')]);
    registry.seal();

    expect(() => registry.registerBatch([command('status')])).toThrow(CommandRegistryStateError);
  });

  it('validates every example against the real parser while sealing', () => {
    const registry = new CommandRegistry();
    registry.registerBatch([
      command('status', {
        argumentMode: 'none',
        examples: [{ invocation: '/status unexpected', description: 'invalid example' }],
      }),
    ]);

    expect(() => registry.seal()).toThrow(CommandExampleValidationError);
    expect(registry.isSealed()).toBe(false);
  });
});
