import { Box, Text } from 'ink';
import React from 'react';

import type { ResolvedConfig } from '../config/schema.js';
import type { ChatSessionController } from '../session/ChatSessionController.js';
import { InputPane } from './components/InputPane.js';
import { StatusBar } from './components/StatusBar.js';
import { TranscriptPane } from './components/TranscriptPane.js';
import { useChatController } from './useChatController.js';

export interface AppProps {
  controller: ChatSessionController;
  resolvedConfig: ResolvedConfig;
}

export function App({ controller, resolvedConfig }: AppProps) {
  const { state, submitText } = useChatController(controller);
  const isStreaming = state.status === 'streaming';

  return (
    <Box flexDirection="column" paddingX={1}>
      <StatusBar resolvedConfig={resolvedConfig} status={state.status} />
      <TranscriptPane
        messages={state.messages}
        draft={state.draft}
        showThinking={resolvedConfig.config.ui.showThinking}
      />
      {state.lastError !== undefined ? (
        <Box marginBottom={1}>
          <Text color="red">Error: {state.lastError.message}</Text>
        </Box>
      ) : null}
      <InputPane disabled={isStreaming} onSubmit={submitText} />
    </Box>
  );
}
