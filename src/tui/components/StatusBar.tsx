import { Box, Text } from 'ink';
import React from 'react';

import type { ResolvedConfig } from '../../config/schema.js';
import type { ChatSessionStatus } from '../../session/types.js';

export interface StatusBarProps {
  resolvedConfig: ResolvedConfig;
  status: ChatSessionStatus;
}

export function StatusBar({ resolvedConfig, status }: StatusBarProps) {
  const label = `AgentCode · model: ${resolvedConfig.config.model} · provider: ${resolvedConfig.config.protocol} · config: ${resolvedConfig.source} · status: ${status}`;

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">{label}</Text>
    </Box>
  );
}
