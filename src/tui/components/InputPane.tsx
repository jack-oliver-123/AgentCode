import { Box, Text, useInput, useStdout } from 'ink';
import React, { useState, type ReactElement } from 'react';

import type { AgentLoopMode } from '../../agent/types.js';

interface SegmenterLike {
  segment(text: string): Iterable<{ segment: string }>;
}

interface SegmenterConstructorLike {
  new (locale: string | undefined, options: { granularity: 'grapheme' }): SegmenterLike;
}

const DEFAULT_DIVIDER_WIDTH = 80;
const MIN_DIVIDER_WIDTH = 40;

export interface InputPaneProps {
  disabled: boolean;
  mode: AgentLoopMode;
  onSubmit(text: string): void;
  onToggleMode(): void;
}

export function InputPane({ disabled, mode, onSubmit, onToggleMode }: InputPaneProps): ReactElement {
  const [input, setInput] = useState('');
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_DIVIDER_WIDTH;
  const dividerWidth = Math.max(MIN_DIVIDER_WIDTH, columns - 2);
  const divider = '─'.repeat(dividerWidth);

  useInput(
    (text, key) => {
      if (disabled) {
        return;
      }

      // Tab 在空输入时切换模式
      if (key.tab && input.length === 0) {
        onToggleMode();
        return;
      }

      if (key.return) {
        const submittedText = input.trim();
        if (submittedText.length > 0) {
          onSubmit(submittedText);
          setInput('');
        }
        return;
      }

      if (key.backspace || key.delete) {
        setInput(removeLastGrapheme);
        return;
      }

      if (text.length > 0 && !key.ctrl && !key.meta) {
        setInput((currentInput) => `${currentInput}${text}`);
      }
    },
    { isActive: !disabled },
  );

  const accentColor = disabled ? 'blue' : 'cyan';
  const inputText = disabled ? 'Waiting for model response…' : input;
  const modePrefix = mode === 'plan' ? 'plan❯ ' : '❯ ';
  const helperText = disabled ? 'Composer paused while AgentCode is generating.' : 'Enter to send · Tab to switch mode';

  return (
    <Box flexDirection="column" aria-role="textbox" aria-state={{ disabled }}>
      <Text color="blue">{divider}</Text>
      <Box>
        <Text color={accentColor}>{modePrefix}</Text>
        <Text>{inputText}</Text>
        {!disabled && input.length === 0 ? <Text color="gray">Ask AgentCode about this project…</Text> : null}
      </Box>
      <Text color="blue">{divider}</Text>
      <Text color="gray">{helperText}</Text>
    </Box>
  );
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
