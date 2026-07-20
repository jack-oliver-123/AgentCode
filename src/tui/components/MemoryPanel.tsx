import { Box, Text, useInput } from 'ink';
import React, { type ReactElement, useEffect, useMemo, useState } from 'react';

import type {
  MemoryEntryContents,
  MemoryEntrySummary,
  MemoryIndexSnapshot,
} from '../../app/memory/MemoryManager.js';
import { removeLastGrapheme } from './InputPane.js';

export interface MemoryPanelProps {
  data: unknown;
  active?: boolean;
  onCommand(command: string): Promise<unknown>;
}

export function MemoryPanel({ data, active = false, onCommand }: MemoryPanelProps): ReactElement {
  if (isMemoryIndexSnapshot(data)) {
    return <MemoryList data={data} active={active} onCommand={onCommand} />;
  }
  if (isMemoryEntryContents(data)) {
    return <MemoryDetail data={data} active={active} onCommand={onCommand} />;
  }
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text color="yellow">Memory data is unavailable.</Text>
    </Box>
  );
}

function MemoryList({
  data,
  active,
  onCommand,
}: {
  data: MemoryIndexSnapshot;
  active: boolean;
  onCommand(command: string): Promise<unknown>;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [routing, setRouting] = useState(false);
  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...data.user, ...data.project].filter((entry) =>
      needle.length === 0 || [entry.title, entry.filename, entry.summary, entry.scope]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [data.project, data.user, query]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  const execute = (command: string): void => {
    if (routing) return;
    setRouting(true);
    void onCommand(command).finally(() => setRouting(false));
  };

  useInput((input, key) => {
    if (routing || input.startsWith('/')) return;
    if (key.upArrow) {
      setSelected((current) => entries.length === 0 ? 0 : (current - 1 + entries.length) % entries.length);
      return;
    }
    if (key.downArrow) {
      setSelected((current) => entries.length === 0 ? 0 : (current + 1) % entries.length);
      return;
    }
    if (key.return || (key.ctrl && input.toLocaleLowerCase() === 'd')) {
      const entry = entries[selected];
      if (entry !== undefined) {
        const operation = key.return ? 'show' : 'delete';
        execute(`/memory ${operation} ${entry.scope} ${entry.filename}`);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(removeLastGrapheme);
      setSelected(0);
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      setQuery((current) => `${current}${input}`);
      setSelected(0);
    }
  }, { isActive: active });

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text color="blue">Memory</Text>
      <Text>Search: {query}</Text>
      {renderScope('USER', data.user, entries, selected)}
      {renderScope('PROJECT', data.project, entries, selected)}
      {entries.length === 0 ? <Text color="yellow">No matching memory entries.</Text> : null}
      <Text color="gray">
        {routing ? 'Opening memory...' : 'Type to search | Up/Down select | Enter show | Ctrl+D delete | Esc close'}
      </Text>
    </Box>
  );
}

function MemoryDetail({
  data,
  active,
  onCommand,
}: {
  data: MemoryEntryContents;
  active: boolean;
  onCommand(command: string): Promise<unknown>;
}): ReactElement {
  const [routing, setRouting] = useState(false);
  useInput((input, key) => {
    if (routing || !key.ctrl || input.toLocaleLowerCase() !== 'd') return;
    setRouting(true);
    void onCommand(`/memory delete ${data.scope} ${data.filename}`).finally(() => setRouting(false));
  }, { isActive: active });

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text color="blue">{data.scope.toUpperCase()} memory | {data.filename}</Text>
      <Text bold>{data.title}</Text>
      {data.summary.length > 0 ? <Text color="gray">{data.summary}</Text> : null}
      <Text wrap="wrap">{data.body}</Text>
      <Text color="gray">{routing ? 'Opening confirmation...' : 'Ctrl+D delete | Esc close'}</Text>
    </Box>
  );
}

function renderScope(
  label: string,
  scopeEntries: readonly MemoryEntrySummary[],
  filtered: readonly MemoryEntrySummary[],
  selected: number,
): ReactElement {
  const visible = scopeEntries.filter((entry) => filtered.includes(entry));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="blue">{label}</Text>
      {visible.length === 0 ? <Text color="gray">  (empty)</Text> : visible.map((entry) => {
        const index = filtered.indexOf(entry);
        return (
          <Text key={`${entry.scope}:${entry.filename}`} color={index === selected ? 'cyan' : 'white'}>
            {index === selected ? '> ' : '  '}{entry.title} <Text color="gray">({entry.filename}) - {entry.summary}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function isMemoryIndexSnapshot(value: unknown): value is MemoryIndexSnapshot {
  return typeof value === 'object' && value !== null &&
    Array.isArray((value as { user?: unknown }).user) &&
    Array.isArray((value as { project?: unknown }).project) &&
    typeof (value as { status?: unknown }).status === 'object';
}

function isMemoryEntryContents(value: unknown): value is MemoryEntryContents {
  return typeof value === 'object' && value !== null &&
    typeof (value as { filename?: unknown }).filename === 'string' &&
    typeof (value as { body?: unknown }).body === 'string' &&
    ((value as { scope?: unknown }).scope === 'user' || (value as { scope?: unknown }).scope === 'project');
}
