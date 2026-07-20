import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

import type { CommandOutput as CommandOutputData } from '../../app/runtime/types.js';

export function CommandOutput({ outputs }: { outputs: readonly CommandOutputData[] }): ReactElement | null {
  if (outputs.length === 0) return null;
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      {outputs.slice(-3).map((output) => (
        <Box key={output.id} flexDirection="column" marginBottom={1}>
          <Text color="blue">/{output.command}</Text>
          <Text wrap="wrap">{output.content}</Text>
        </Box>
      ))}
    </Box>
  );
}
