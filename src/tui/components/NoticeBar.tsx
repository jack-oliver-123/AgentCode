import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

import type { PublicError } from '../../shared/errors.js';

export interface NoticeBarProps {
  error?: PublicError | undefined;
  notice?: string | undefined;
}

export function NoticeBar({ error, notice }: NoticeBarProps): ReactElement | null {
  if (error === undefined && notice === undefined) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {notice !== undefined ? <Text color="cyan">ℹ {notice}</Text> : null}
      {error !== undefined ? (
        <>
          <Text color="red">⚠ Error ({error.code}): {error.message}</Text>
          <Text color="gray">{error.retryable ? 'You can retry by sending another message.' : 'Fix the issue, then send another message.'}</Text>
        </>
      ) : null}
    </Box>
  );
}
