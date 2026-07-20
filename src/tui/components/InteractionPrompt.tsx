import { Box, Text, useInput } from 'ink';
import React, { type ReactElement, useMemo, useState } from 'react';

import type {
  InteractionRequest,
  InteractionResponse,
} from '../../app/interaction/InteractionCoordinator.js';
import { removeLastGrapheme } from './InputPane.js';

export interface InteractionPromptProps {
  request: InteractionRequest;
  onRespond(response: InteractionResponse): void;
  active?: boolean;
}

export function InteractionPrompt({ request, onRespond, active = true }: InteractionPromptProps): ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const choices = useMemo(() => {
    if (request.kind !== 'session-picker') return [];
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length === 0) return request.choices;
    return request.choices.filter((choice) =>
      [choice.id, choice.name ?? '', String(choice.updatedAt), new Date(choice.updatedAt).toISOString()]
        .some((value) => value.toLocaleLowerCase().includes(normalized)),
    );
  }, [query, request]);
  const windowStart = Math.min(Math.max(0, selected - 7), Math.max(0, choices.length - 8));
  const visibleChoices = choices.slice(windowStart, windowStart + 8);

  useInput((input, key) => {
    if (input.startsWith('/')) return;
    if (key.escape || (request.kind !== 'session-picker' && input.toLocaleLowerCase() === 'n')) {
      onRespond({ kind: 'cancelled' });
      return;
    }
    if (request.kind !== 'session-picker') {
      if (key.return || input.toLocaleLowerCase() === 'y') onRespond({ kind: 'confirmed' });
      return;
    }
    if (key.upArrow) {
      setSelected((current) => choices.length === 0 ? 0 : (current - 1 + choices.length) % choices.length);
      return;
    }
    if (key.downArrow) {
      setSelected((current) => choices.length === 0 ? 0 : (current + 1) % choices.length);
      return;
    }
    if (key.return) {
      const choice = choices[selected];
      if (choice !== undefined) onRespond({ kind: 'selected', value: choice.id });
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
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>{interactionTitle(request)}</Text>
      <Text color="gray">request: {request.id}</Text>
      {request.kind === 'session-picker' ? (
        <>
          <Text>Search: {query}</Text>
          {choices.length === 0 ? <Text color="yellow">No matching sessions.</Text> : null}
          {visibleChoices.map((choice, index) => {
            const choiceIndex = windowStart + index;
            return (
            <Text key={choice.id} color={choiceIndex === selected ? 'cyan' : 'white'}>
              {choiceIndex === selected ? '❯ ' : '  '}{choice.name ?? '(unnamed)'} · {choice.id}
              {' '}· {new Date(choice.updatedAt).toISOString().replace('T', ' ').slice(0, 16)}
              {choice.current ? ' · current' : choice.locked ? ' · locked' : choice.restorable === false ? ' · unavailable' : ' · restorable'}
            </Text>
            );
          })}
          <Text color="gray">Type to search · ↑/↓ select · Enter resume · Esc cancel</Text>
        </>
      ) : (
        <>
          <Text wrap="wrap">{confirmationDescription(request)}</Text>
          <Text color="gray">Y/Enter confirm · N/Esc cancel</Text>
        </>
      )}
    </Box>
  );
}

function interactionTitle(request: InteractionRequest): string {
  switch (request.kind) {
    case 'session-picker': return 'Resume session';
    case 'confirm-memory-delete': return 'Delete memory entry?';
    case 'confirm-permission-remove': return 'Remove permission rule?';
    case 'confirm-permission-mode': return 'Expand permission mode?';
    case 'confirm-queue-remove': return 'Remove Queue item?';
    case 'confirm-queue-clear': return 'Clear Queue?';
    case 'tool-approval': return 'Tool approval';
  }
}

function confirmationDescription(request: Exclude<InteractionRequest, { kind: 'session-picker' }>): string {
  switch (request.kind) {
    case 'confirm-memory-delete':
      return `${request.scope.toUpperCase()} memory ${request.entry} will be permanently deleted.`;
    case 'confirm-permission-remove':
      return `Remove ${request.scope} rule ${request.ruleId}.`;
    case 'confirm-permission-mode':
      return `Switch selected permission mode to ${request.mode}. This affects only tool calls that have not started.`;
    case 'confirm-queue-remove':
      return `Remove Queue item ${request.index}.`;
    case 'confirm-queue-clear':
      return 'Remove every pending Queue item.';
    case 'tool-approval':
      return request.description;
  }
}
