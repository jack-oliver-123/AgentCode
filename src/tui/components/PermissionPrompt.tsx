import { Box, Text, useInput } from 'ink';
import React, { useState, type ReactElement } from 'react';

import type { PromptResponse } from '../../tools/permissions/types.js';

export interface PermissionPromptProps {
  toolName: string;
  description: string;
  onRespond(response: PromptResponse): void;
}

interface Option {
  label: string;
  key: string;
  response: PromptResponse;
}

const OPTIONS: readonly Option[] = [
  { label: '[1] 允许(本次)', key: '1', response: { action: 'allow_once' } },
  { label: '[2] 允许(本会话)', key: '2', response: { action: 'allow_session' } },
  { label: '[3] 允许(永久)', key: '3', response: { action: 'allow_permanent' } },
  { label: '[4] 拒绝', key: '4', response: { action: 'deny' } },
];

export function PermissionPrompt({ toolName, description, onRespond }: PermissionPromptProps): ReactElement {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    // 数字键直接选择
    for (const option of OPTIONS) {
      if (input === option.key) {
        onRespond(option.response);
        return;
      }
    }

    // 方向键选择
    if (key.upArrow) {
      setSelected((prev) => (prev > 0 ? prev - 1 : OPTIONS.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((prev) => (prev < OPTIONS.length - 1 ? prev + 1 : 0));
      return;
    }

    // Enter 确认当前选中
    if (key.return) {
      const opt = OPTIONS[selected];
      if (opt !== undefined) {
        onRespond(opt.response);
      }
      return;
    }

    // Escape 拒绝
    if (key.escape) {
      onRespond({ action: 'deny' });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
      <Text color="blue" bold>
        ⚡ 权限请求
      </Text>
      <Box marginY={1} flexDirection="column">
        <Text>
          工具: <Text color="white" bold>{toolName}</Text>
        </Text>
        <Text>{description}</Text>
      </Box>
      <Box flexDirection="column">
        {OPTIONS.map((option, index) => (
          <Text key={option.key} color={index === selected ? 'cyan' : 'white'}>
            {index === selected ? '❯ ' : '  '}
            {option.label}
          </Text>
        ))}
      </Box>
      <Text color="gray">↑↓ 选择 · Enter 确认 · 1-4 快捷键 · Esc 拒绝</Text>
    </Box>
  );
}
