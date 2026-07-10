import { Box } from 'ink';
import React, { type ReactElement, useEffect, useState } from 'react';

import type { ResolvedConfig } from '../config/schema.js';
import type { ChatSessionController } from '../session/ChatSessionController.js';
import { InputPane } from './components/InputPane.js';
import { NoticeBar } from './components/NoticeBar.js';
import { PermissionPrompt } from './components/PermissionPrompt.js';
import { StatusBar } from './components/StatusBar.js';
import { TranscriptPane } from './components/TranscriptPane.js';
import type { PermissionPromptCoordinator } from './permissionPromptCoordinator.js';
import { useChatController } from './useChatController.js';

export interface AppProps {
  controller: ChatSessionController;
  resolvedConfig: ResolvedConfig;
  cwd?: string;
  permissionPromptCoordinator?: PermissionPromptCoordinator;
}

export function App({ controller, cwd, resolvedConfig, permissionPromptCoordinator }: AppProps): ReactElement {
  const { state, submitText, toggleMode } = useChatController(controller);
  const [permissionPrompt, setPermissionPrompt] = useState(() => permissionPromptCoordinator?.getSnapshot());
  const isStreaming = state.status === 'streaming';

  useEffect(() => {
    if (permissionPromptCoordinator === undefined) {
      setPermissionPrompt(undefined);
      return;
    }

    setPermissionPrompt(permissionPromptCoordinator.getSnapshot());
    const unsubscribe = permissionPromptCoordinator.subscribe(() => {
      setPermissionPrompt(permissionPromptCoordinator.getSnapshot());
    });

    return () => {
      unsubscribe();
      permissionPromptCoordinator.dispose();
    };
  }, [permissionPromptCoordinator]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <StatusBar cwd={cwd} resolvedConfig={resolvedConfig} status={state.status} />
      <TranscriptPane
        messages={state.messages}
        draft={state.draft}
        showThinking={resolvedConfig.config.ui.showThinking}
      />
      <NoticeBar error={state.lastError} notice={state.notice} />
      {permissionPrompt !== undefined && permissionPromptCoordinator !== undefined ? (
        <PermissionPrompt
          toolName={permissionPrompt.toolName}
          description={permissionPrompt.description}
          onRespond={(response) => permissionPromptCoordinator.respond(permissionPrompt.id, response)}
        />
      ) : (
        <InputPane disabled={isStreaming} mode={state.mode} onSubmit={submitText} onToggleMode={toggleMode} />
      )}
    </Box>
  );
}
