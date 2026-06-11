import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

import type { PublicError } from '../../shared/errors.js';

export interface NoticeBarProps {
  error?: PublicError | undefined;
}

export function NoticeBar({ error }: NoticeBarProps): ReactElement | null {
  if (error === undefined) {
    return null;
  }

  const retryHint = error.retryable ? 'You can retry by sending another message.' : 'Fix the issue, then send another message.';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="red">⚠ Error ({error.code}): {error.message}</Text>
      <Text color="gray">{retryHint}</Text>
    </Box>
  );
}
