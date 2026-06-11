import { basename, dirname } from 'node:path';

import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

import type { ResolvedConfig } from '../../config/schema.js';
import type { ChatSessionStatus } from '../../session/types.js';

export interface StatusBarProps {
  cwd?: string | undefined;
  resolvedConfig: ResolvedConfig;
  status: ChatSessionStatus;
}

const STATUS_LABELS: Record<ChatSessionStatus, string> = {
  idle: 'ready',
  streaming: 'generating',
  error: 'needs attention'
};

export function StatusBar({ cwd, resolvedConfig, status }: StatusBarProps): ReactElement {
  const statusLabel = STATUS_LABELS[status];
  const cwdLabel = formatCwdLabel(cwd, resolvedConfig);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="blue"> /\_/\   </Text>
        <Text color="white">AgentCode</Text>
        <Text color="gray"> · {statusLabel}</Text>
      </Box>
      <Box>
        <Text color="blue">( </Text>
        <Text color="cyan">●</Text>
        <Text color="blue">.</Text>
        <Text color="cyan">●</Text>
        <Text color="blue"> )  </Text>
        <Text color="gray">model: </Text>
        <Text color="cyan">{resolvedConfig.config.model}</Text>
        <Text color="gray"> · provider: {resolvedConfig.config.protocol} · config: {resolvedConfig.source}</Text>
      </Box>
      <Box>
        <Text color="blue"> &gt; ^ &lt;   </Text>
        <Text color="gray">cwd: {cwdLabel}</Text>
      </Box>
    </Box>
  );
}

function formatCwdLabel(cwd: string | undefined, resolvedConfig: ResolvedConfig): string {
  if (cwd !== undefined) {
    return basename(cwd) || cwd;
  }

  const configDirectory = dirname(resolvedConfig.path);
  return basename(dirname(configDirectory)) || basename(configDirectory);
}
