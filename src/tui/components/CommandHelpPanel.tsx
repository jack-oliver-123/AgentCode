import { Box, Text, useInput } from 'ink';
import React, { type ReactElement, useMemo, useState } from 'react';

import type { CommandMetadata } from '../../commands/types.js';
import { removeLastGrapheme } from './InputPane.js';

const CATEGORY_ORDER = ['general', 'conversation', 'mode', 'workspace', 'workflow', 'runtime'] as const;

export function CommandHelpPanel({ data, active = false }: { data: unknown; active?: boolean }): ReactElement {
  const commands = Array.isArray(data) ? data.filter(isMetadata) : isMetadata(data) ? [data] : [];
  const detailed = commands.length === 1;
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return commands;
    return commands.filter((command) => [
      command.name,
      ...command.aliases,
      command.summary,
      command.category,
      ...command.usage,
    ].some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [commands, query]);
  const groups = useMemo(() => groupCommands(filtered), [filtered]);

  useInput((input, key) => {
    if (detailed) return;
    if (input.startsWith('/')) return;
    if (key.backspace || key.delete) {
      setQuery(removeLastGrapheme);
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) setQuery((current) => `${current}${input}`);
  }, { isActive: active });

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text color="blue">Command help</Text>
      {!detailed ? <Text>Search: {query}</Text> : null}
      {detailed ? commands.map(renderDetailedCommand) : groups.map(([category, entries]) => (
        <Box key={category} flexDirection="column" marginTop={1}>
          <Text color="blue">{category.toLocaleUpperCase()}</Text>
          {entries.map((command) => (
            <Text key={command.name}>
              <Text color="cyan">/{command.name}</Text>
              <Text color="gray">
                {command.aliases.length > 0 ? ` (${command.aliases.map((alias) => `/${alias}`).join(', ')})` : ''}
                {' - '}{command.summary}
              </Text>
            </Text>
          ))}
        </Box>
      ))}
      {!detailed && filtered.length === 0 ? <Text color="yellow">No matching commands.</Text> : null}
    </Box>
  );
}

function renderDetailedCommand(command: CommandMetadata): ReactElement {
  return (
    <Box key={command.name} flexDirection="column" marginBottom={1}>
      <Text color="cyan">
        /{command.name}{command.aliases.length > 0 ? ` - ${command.aliases.map((alias) => `/${alias}`).join(', ')}` : ''}
      </Text>
      <Text>{command.summary}</Text>
      <Text color="gray">
        {command.category} - {command.execution} - active: {command.activeRunPolicy} - AI: {command.execution === 'local' ? 'no' : 'yes'}
      </Text>
      <Text color="gray">Usage: {command.usage.join(' | ')}</Text>
      {command.argumentHint !== undefined ? <Text>Arguments: {command.argumentHint}</Text> : null}
      <Text>Effects: {command.effects.join(', ') || 'none'}</Text>
      {command.examples.map((example) => (
        <Text key={example.invocation} color="gray">Example: {example.invocation} - {example.description}</Text>
      ))}
    </Box>
  );
}

function groupCommands(commands: readonly CommandMetadata[]): Array<[string, CommandMetadata[]]> {
  const groups = new Map<string, CommandMetadata[]>();
  for (const command of commands) {
    const category = command.category || 'other';
    const entries = groups.get(category) ?? [];
    entries.push(command);
    groups.set(category, entries);
  }
  const order = new Map<string, number>(CATEGORY_ORDER.map((category, index) => [category, index]));
  return [...groups.entries()].sort(([left], [right]) =>
    (order.get(left) ?? CATEGORY_ORDER.length) - (order.get(right) ?? CATEGORY_ORDER.length) || left.localeCompare(right),
  );
}

function isMetadata(value: unknown): value is CommandMetadata {
  return typeof value === 'object' && value !== null && 'name' in value && 'usage' in value;
}
