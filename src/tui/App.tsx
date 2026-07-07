import { Box } from 'ink';
import React, { type ReactElement } from 'react';

import type { ResolvedConfig } from '../config/schema.js';
import type { ChatSessionController } from '../session/ChatSessionController.js';
import { InputPane } from './components/InputPane.js';
import { NoticeBar } from './components/NoticeBar.js';
import { StatusBar } from './components/StatusBar.js';
import { TranscriptPane } from './components/TranscriptPane.js';
import { useChatController } from './useChatController.js';

export interface AppProps {
  controller: ChatSessionController;
  resolvedConfig: ResolvedConfig;
  cwd?: string;
}

export function App({ controller, cwd, resolvedConfig }: AppProps): ReactElement {
  const { state, submitText, toggleMode } = useChatController(controller);
  const isStreaming = state.status === 'streaming';

  return (
    <Box flexDirection="column" paddingX={1}>
      <StatusBar cwd={cwd} resolvedConfig={resolvedConfig} status={state.status} />
      <TranscriptPane
        messages={state.messages}
        draft={state.draft}
        showThinking={resolvedConfig.config.ui.showThinking}
      />
      <NoticeBar error={state.lastError} notice={state.notice} />
      <InputPane disabled={isStreaming} mode={state.mode} onSubmit={submitText} onToggleMode={toggleMode} />
    </Box>
  );
}
