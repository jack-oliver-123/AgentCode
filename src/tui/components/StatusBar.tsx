import { basename, dirname } from 'node:path';

import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

import type { StatusBarSnapshot } from '../../app/status/StatusService.js';
import type { ResolvedConfig } from '../../config/schema.js';

export interface StatusBarProps {
  cwd?: string | undefined;
  resolvedConfig: ResolvedConfig;
  snapshot: StatusBarSnapshot;
}

export function StatusBar({ cwd, resolvedConfig, snapshot }: StatusBarProps): ReactElement {
  const cwdLabel = formatCwdLabel(cwd, resolvedConfig);
  const mode = snapshot.mode === 'review' ? '[REVIEW]' : snapshot.mode === 'plan' ? '[PLAN]' : '[DEFAULT]';
  const runStatus = snapshot.runStatus === 'streaming' ? 'generating' : snapshot.runStatus;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="blue"> /\_/\ </Text>
        <Text color="white">AgentCode</Text>
        <Text color="cyan"> {mode}</Text>
        <Text color="gray"> · {runStatus === 'idle' ? 'ready' : runStatus}</Text>
      </Box>
      <Box>
        <Text color="blue">( </Text><Text color="cyan">●</Text><Text color="blue">.</Text><Text color="cyan">●</Text><Text color="blue"> ) </Text>
        <Text color="gray">model: </Text><Text color="cyan">{snapshot.model}</Text>
        <Text color="gray"> · estimated: {snapshot.estimatedTokens} tokens ({snapshot.contextPercent}%)</Text>
      </Box>
      <Box>
        <Text color="blue"> &gt; ^ &lt; </Text>
        <Text color="gray">
          cwd: {cwdLabel} · provider: {resolvedConfig.config.protocol} · config: {resolvedConfig.source}
        </Text>
        {snapshot.queueCount > 0 || snapshot.queuePaused ? (
          <Text color={snapshot.queuePaused ? 'yellow' : 'cyan'}>
            {' '}· queued: {snapshot.queueCount}{snapshot.queuePaused ? ' · paused' : ''}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function formatCwdLabel(cwd: string | undefined, resolvedConfig: ResolvedConfig): string {
  if (cwd !== undefined) return basename(cwd) || cwd;
  const configDirectory = dirname(resolvedConfig.path);
  return basename(dirname(configDirectory)) || basename(configDirectory);
}
