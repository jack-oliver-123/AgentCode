import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

export function StatusPanel({ data }: { data: unknown }): ReactElement {
  const sections = statusSections(data);
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text color="blue">Status details</Text>
      {sections.map(([label, value]) => (
        <Text key={label} wrap="truncate-end">
          <Text color="cyan">{label}: </Text>{value}
        </Text>
      ))}
    </Box>
  );
}

function statusSections(data: unknown): Array<[string, string]> {
  if (!isRecord(data)) return [['status', inline(data)]];
  const sections: Array<[string, string]> = [];
  for (const key of ['runtime', 'provider', 'context', 'session', 'permission', 'memory', 'git', 'mcp', 'config'] as const) {
    if (data[key] !== undefined) sections.push([key, inline(data[key])]);
  }
  if (isRecord(data['errors'])) {
    if (data['errors']['command'] !== undefined) sections.push(['command error', inline(data['errors']['command'])]);
    if (data['errors']['agent'] !== undefined) sections.push(['agent error', inline(data['errors']['agent'])]);
  }
  return sections.length > 0 ? sections : [['status', inline(data)]];
}

function inline(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialized === undefined) return String(value);
  const singleLine = serialized.replace(/\s+/gu, ' ');
  return singleLine.length <= 220 ? singleLine : `${singleLine.slice(0, 217)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
