import { CommandRegistry } from '../registry.js';
import type { CommandDefinition } from '../types.js';
import { handleBuiltin } from './handlers.js';
import { BUILTIN_COMMAND_METADATA } from './metadata.js';
import { parseBuiltinOperation } from './operations.js';

export { BUILTIN_COMMAND_METADATA } from './metadata.js';
export type { BuiltinOperation } from './operations.js';

export function createBuiltinCommands(): readonly CommandDefinition[] {
  let commands: readonly CommandDefinition[] = [];
  commands = BUILTIN_COMMAND_METADATA.map((metadata): CommandDefinition => ({
    metadata,
    parseOperation: (input) => parseBuiltinOperation(metadata.name, input),
    handle: (context, operation) => handleBuiltin(context, operation as import('./operations.js').BuiltinOperation, commands),
  }));
  return commands;
}

export function createBuiltinCommandRegistry(): CommandRegistry<CommandDefinition> {
  const registry = new CommandRegistry<CommandDefinition>();
  registry.registerBatch(createBuiltinCommands());
  registry.seal();
  return registry;
}
