import { Box, Text, useInput } from 'ink';
import React, { type ReactElement, useEffect, useState } from 'react';

import type { AppRuntime } from '../app/runtime/AppRuntime.js';
import type { InputRouter } from '../app/runtime/InputRouter.js';
import type { StatusService } from '../app/status/StatusService.js';
import type {
  InteractionCoordinator,
  InteractionRequest,
  InteractionResponse,
} from '../app/interaction/InteractionCoordinator.js';
import type { ResolvedConfig } from '../config/schema.js';
import { CommandHelpPanel } from './components/CommandHelpPanel.js';
import { CommandOutput } from './components/CommandOutput.js';
import { InputPane } from './components/InputPane.js';
import { InteractionPrompt } from './components/InteractionPrompt.js';
import { MemoryPanel } from './components/MemoryPanel.js';
import { NoticeBar } from './components/NoticeBar.js';
import { PermissionPrompt } from './components/PermissionPrompt.js';
import { ReviewPanel } from './components/ReviewPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { StatusPanel } from './components/StatusPanel.js';
import { TranscriptPane } from './components/TranscriptPane.js';
import type { PermissionPromptCoordinator } from './permissionPromptCoordinator.js';
import { useAppRuntime } from './useChatController.js';

export interface AppProps {
  runtime: AppRuntime;
  inputRouter: Pick<InputRouter, 'route'> & Partial<Pick<InputRouter, 'resetCompletion'>>;
  statusService: Pick<StatusService, 'getStatusBar'>;
  resolvedConfig: ResolvedConfig;
  cwd?: string;
  permissionPromptCoordinator?: PermissionPromptCoordinator;
  interactionCoordinator?: Pick<InteractionCoordinator, 'settle'>;
  onDispose?: () => void | Promise<void>;
}

export function App({
  runtime,
  inputRouter,
  statusService,
  cwd,
  resolvedConfig,
  permissionPromptCoordinator,
  interactionCoordinator,
  onDispose,
}: AppProps): ReactElement {
  const { snapshot, routeInput } = useAppRuntime(runtime, inputRouter);
  const [permissionPrompt, setPermissionPrompt] = useState(() => permissionPromptCoordinator?.getSnapshot());
  const [runtimeControlActive, setRuntimeControlActive] = useState(false);
  const statusBar = statusService.getStatusBar();
  const interaction = isInteractionRequest(snapshot.interaction?.data) ? snapshot.interaction.data : undefined;
  const permissionModalActive = permissionPrompt !== undefined && permissionPromptCoordinator !== undefined;
  const interactionModalActive = interaction !== undefined && interactionCoordinator !== undefined;
  const modalActive = permissionModalActive || interactionModalActive;
  const panelCapturesInput = snapshot.panel?.kind === 'memory' ||
    (snapshot.panel?.kind === 'help' && Array.isArray(snapshot.panel.data));

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

  useEffect(() => () => {
    void onDispose?.();
  }, [onDispose]);

  useEffect(() => {
    const notice = snapshot.notice;
    if (notice?.ttlMs === undefined) return;
    const timer = setTimeout(() => {
      runtime.dispatch({ type: 'notice.cleared', id: notice.id });
    }, notice.ttlMs);
    return () => clearTimeout(timer);
  }, [runtime, snapshot.notice]);

  useInput((_input, key) => {
    if (
      key.escape &&
      snapshot.panel !== undefined &&
      permissionPrompt === undefined &&
      interaction === undefined
    ) {
      runtime.dispatch({ type: 'panel.closed', id: snapshot.panel.id });
    }
  });

  const respondToInteraction = (response: InteractionResponse): void => {
    if (interaction === undefined || interactionCoordinator === undefined) return;
    void interactionCoordinator.settle(interaction.id, response).catch((error) => {
      runtime.dispatch({
        type: 'command.error',
        error: {
          code: 'interaction_failed',
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        },
      });
    });
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <StatusBar cwd={cwd} resolvedConfig={resolvedConfig} snapshot={statusBar} />
      <TranscriptPane
        messages={snapshot.chat.messages}
        draft={snapshot.chat.draft}
        activities={snapshot.chat.activities}
        showThinking={resolvedConfig.config.ui.showThinking}
      />
      <CommandOutput outputs={snapshot.commandOutputs} />
      {snapshot.panel?.kind === 'help' ? (
        <CommandHelpPanel
          data={snapshot.panel.data}
          active={panelCapturesInput && !modalActive && !runtimeControlActive}
        />
      ) : null}
      {snapshot.panel?.kind === 'status' ? <StatusPanel data={snapshot.panel.data} /> : null}
      {snapshot.panel?.kind === 'review' ? <ReviewPanel data={snapshot.panel.data} /> : null}
      {snapshot.panel?.kind === 'memory' ? (
        <MemoryPanel
          data={snapshot.panel.data}
          active={panelCapturesInput && !modalActive && !runtimeControlActive}
          onCommand={(command) => routeInput(command, 'enter')}
        />
      ) : null}
      {snapshot.panel !== undefined && snapshot.panel.kind !== 'help' && snapshot.panel.kind !== 'status' && snapshot.panel.kind !== 'review' && snapshot.panel.kind !== 'memory' ? (
        <Box flexDirection="column" marginY={1} paddingLeft={2}>
          <Text color="blue">{snapshot.panel.title}</Text>
          <Text wrap="wrap">{JSON.stringify(snapshot.panel.data, null, 2)}</Text>
        </Box>
      ) : null}
      <NoticeBar
        error={snapshot.agentError}
        commandError={snapshot.commandError}
        notice={snapshot.notice?.text ?? snapshot.chat.notice}
      />
      {permissionModalActive ? (
        <PermissionPrompt
          active={!runtimeControlActive}
          toolName={permissionPrompt.toolName}
          description={permissionPrompt.description}
          onRespond={(response) => permissionPromptCoordinator.respond(permissionPrompt.id, response)}
        />
      ) : null}
      {interactionModalActive && !permissionModalActive ? (
        <InteractionPrompt
          request={interaction}
          active={!runtimeControlActive}
          onRespond={respondToInteraction}
        />
      ) : null}
      <InputPane
        activeRun={snapshot.run.phase !== 'idle' || snapshot.queue.draining}
        mode={snapshot.mode}
        modalActive={modalActive}
        suspended={panelCapturesInput}
        onControlActiveChange={setRuntimeControlActive}
        onRoute={routeInput}
        onCancelCompletion={() => inputRouter.resetCompletion?.()}
      />
    </Box>
  );
}

function isInteractionRequest(value: unknown): value is InteractionRequest {
  return typeof value === 'object' && value !== null && 'id' in value && 'kind' in value;
}
