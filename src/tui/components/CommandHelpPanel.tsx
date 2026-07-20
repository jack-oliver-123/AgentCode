import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

import type { CommandMetadata } from '../../commands/types.js';

export function CommandHelpPanel({ data }: { data: unknown }): ReactElement {
  const commands = Array.isArray(data) ? data.filter(isMetadata) : isMetadata(data) ? [data] : [];
  const detailed = commands.length === 1;
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text color="blue">Command help</Text>
      {commands.map((command) => (
        <Box key={command.name} flexDirection="column" marginBottom={detailed ? 1 : 0}>
          {detailed ? (
            <>
              <Text color="cyan">/{command.name}{command.aliases.length > 0 ? ` · ${command.aliases.map((alias) => `/${alias}`).join(', ')}` : ''}</Text>
              <Text>{command.summary}</Text>
              <Text color="gray">{command.category} · {command.execution} · active: {command.activeRunPolicy} · AI: {command.execution === 'local' ? 'no' : 'yes'}</Text>
              <Text color="gray">Usage: {command.usage.join(' | ')}</Text>
              {command.argumentHint !== undefined ? <Text>Arguments: {command.argumentHint}</Text> : null}
              <Text>Effects: {command.effects.join(', ') || 'none'}</Text>
              {command.examples.map((example) => (
                <Text key={example.invocation} color="gray">Example: {example.invocation} — {example.description}</Text>
              ))}
            </>
          ) : (
            <Text>
              <Text color="cyan">/{command.name}</Text>
              <Text color="gray">{command.aliases.length > 0 ? ` (${command.aliases.map((alias) => `/${alias}`).join(', ')})` : ''} — {command.summary}</Text>
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function isMetadata(value: unknown): value is CommandMetadata {
  return typeof value === 'object' && value !== null && 'name' in value && 'usage' in value;
}
