import { Box, Text, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { InputIntent, InputRouteResult } from '../../app/runtime/InputRouter.js';
import type { AgentMode } from '../../app/runtime/types.js';

interface SegmenterLike {
  segment(text: string): Iterable<{ segment: string }>;
}

interface SegmenterConstructorLike {
  new (locale: string | undefined, options: { granularity: 'grapheme' }): SegmenterLike;
}

const DEFAULT_DIVIDER_WIDTH = 80;
const MIN_DIVIDER_WIDTH = 40;

export interface InputPaneProps {
  mode: AgentMode;
  activeRun: boolean;
  onRoute(text: string, intent: InputIntent): Promise<InputRouteResult>;
  onCancelCompletion?: () => void;
  modalActive?: boolean;
  suspended?: boolean;
  onControlActiveChange?: (active: boolean) => void;
}

export function InputPane({
  mode,
  activeRun,
  onRoute,
  onCancelCompletion,
  modalActive = false,
  suspended = false,
  onControlActiveChange,
}: InputPaneProps): ReactElement {
  const [input, setInput] = useState('');
  const inputRef = useRef(input);
  const setInputValue = useCallback((value: string) => {
    inputRef.current = value;
    setInput(value);
  }, []);
  const [candidates, setCandidates] = useState<readonly string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<number | undefined>();
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const [historyDraft, setHistoryDraft] = useState('');
  const [routing, setRouting] = useState(false);
  const routingRef = useRef(false);
  const [controlInput, setControlInput] = useState<string | undefined>();
  const controlInputRef = useRef<string | undefined>(undefined);
  const setControlInputValue = useCallback((value: string | undefined) => {
    controlInputRef.current = value;
    setControlInput(value);
  }, []);
  const [controlRouting, setControlRouting] = useState(false);
  const controlRoutingRef = useRef(false);
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_DIVIDER_WIDTH;
  const dividerWidth = Math.max(MIN_DIVIDER_WIDTH, columns - 2);
  const divider = '─'.repeat(dividerWidth);

  useEffect(() => {
    if (modalActive || suspended || routing) return;
    setControlInputValue(undefined);
    onControlActiveChange?.(false);
  }, [modalActive, onControlActiveChange, routing, setControlInputValue, suspended]);

  const route = useCallback(
    (intent: InputIntent) => {
      if (routingRef.current) return;
      const submittedInput = inputRef.current;
      routingRef.current = true;
      setRouting(true);
      void onRoute(submittedInput, intent)
        .then((result) => {
          if (result.kind === 'completion') {
            if (inputRef.current === submittedInput) {
              setCandidates(result.candidates ?? []);
              setSelectedCandidate(result.selectedIndex);
              setInputValue(result.input);
            }
            return;
          }
          if (shouldRecordHistory(submittedInput, result)) {
            setHistory((current) => [...current, submittedInput].slice(-100));
            setHistoryIndex(undefined);
            setHistoryDraft('');
          }
          setCandidates([]);
          setSelectedCandidate(undefined);
          if (result.clearInput) {
            const current = inputRef.current;
            setInputValue(current === submittedInput
              ? ''
              : current.startsWith(submittedInput) ? current.slice(submittedInput.length) : current);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          routingRef.current = false;
          setRouting(false);
        });
    },
    [onRoute, setInputValue],
  );

  const routeControl = useCallback(() => {
    const submitted = controlInputRef.current;
    if (submitted === undefined || controlRoutingRef.current) return;
    controlRoutingRef.current = true;
    setControlRouting(true);
    void onRoute(submitted, 'enter')
      .then((result) => {
        if (result.clearInput) {
          setControlInputValue(undefined);
          onControlActiveChange?.(false);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        controlRoutingRef.current = false;
        setControlRouting(false);
      });
  }, [onControlActiveChange, onRoute, setControlInputValue]);

  useInput((text, key) => {
    if (modalActive || suspended || routingRef.current || controlInputRef.current !== undefined) {
      if (controlInputRef.current === undefined) {
        if (text.startsWith('/')) {
          setControlInputValue(text);
          onControlActiveChange?.(true);
        }
        return;
      }
      if (key.escape) {
        setControlInputValue(undefined);
        onControlActiveChange?.(false);
        return;
      }
      if (key.return) {
        routeControl();
        return;
      }
      if (key.backspace || key.delete) {
        const next = removeLastGrapheme(controlInputRef.current ?? '');
        if (next.length === 0) onControlActiveChange?.(false);
        setControlInputValue(next.length === 0 ? undefined : next);
        return;
      }
      if (text.length > 0 && !key.ctrl && !key.meta) {
        setControlInputValue(`${controlInputRef.current ?? ''}${text}`);
      }
      return;
    }
    if (key.escape && candidates.length > 0) {
      setCandidates([]);
      setSelectedCandidate(undefined);
      onCancelCompletion?.();
      return;
    }
    if (key.tab) {
      route(key.shift ? 'shift-tab' : 'tab');
      return;
    }
    if (key.return) {
      route(key.meta ? 'alt-enter' : 'enter');
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue(removeLastGrapheme(inputRef.current));
      setCandidates([]);
      setSelectedCandidate(undefined);
      setHistoryIndex(undefined);
      return;
    }
    if (key.upArrow && history.length > 0) {
      const next = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1);
      if (historyIndex === undefined) setHistoryDraft(inputRef.current);
      setHistoryIndex(next);
      setInputValue(history[next] ?? inputRef.current);
      setCandidates([]);
      return;
    }
    if (key.downArrow && historyIndex !== undefined) {
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(undefined);
        setInputValue(historyDraft);
      } else {
        setHistoryIndex(next);
        setInputValue(history[next] ?? inputRef.current);
      }
      setCandidates([]);
      return;
    }
    if (text.length > 0 && !key.ctrl && !key.meta) {
      setInputValue(`${inputRef.current}${text}`);
      setCandidates([]);
      setSelectedCandidate(undefined);
      setHistoryIndex(undefined);
    }
  });

  const modePrefix = mode === 'plan' ? 'plan❯ ' : '❯ ';
  const helperText = activeRun
    ? 'Enter steer · Alt+Enter queue · Tab complete · Shift+Tab mode'
    : 'Enter send · Tab complete · Shift+Tab mode';

  return (
    <Box flexDirection="column" aria-role="textbox" aria-state={{ disabled: false }}>
      {candidates.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="blue">Commands</Text>
          <Text color="gray" wrap="wrap">
            {candidates.map((candidate, index) => `${index === selectedCandidate ? '❯ ' : ''}${candidate}`).join('  ')}
          </Text>
        </Box>
      ) : null}
      <Text color="blue">{divider}</Text>
      <Box>
        <Text color={activeRun ? 'blue' : 'cyan'}>{modePrefix}</Text>
        <Text>{input}</Text>
        {input.length === 0 ? (
          <Text color="gray">{activeRun ? 'Steer this run or queue the next task…' : 'Ask AgentCode about this project…'}</Text>
        ) : null}
      </Box>
      {controlInput !== undefined ? <Text color="yellow">Runtime control: {controlInput}</Text> : null}
      <Text color="blue">{divider}</Text>
      <Text color="gray">
        {controlRouting
          ? 'Routing runtime control…'
          : routing || modalActive
            ? 'Type / for runtime controls'
            : suspended
              ? 'Panel input active - type / for runtime controls'
              : helperText}
      </Text>
    </Box>
  );
}

function shouldRecordHistory(input: string, result: InputRouteResult): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0 || /^\/(?:clear|new)(?:\s|$)/iu.test(trimmed)) return false;
  if (result.kind === 'command' || result.kind === 'error') return true;
  return (result.kind === 'prompt' || result.kind === 'steer' || result.kind === 'queue') && result.accepted;
}

export function removeLastGrapheme(text: string): string {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructorLike }).Segmenter;
  if (Segmenter !== undefined) {
    const segments = Array.from(
      new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (segment) => segment.segment,
    );
    return segments.slice(0, -1).join('');
  }
  return Array.from(text).slice(0, -1).join('');
}
