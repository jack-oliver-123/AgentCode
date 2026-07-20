import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  type BootstrapDependencies,
  bootstrapApp,
} from '../../src/app/bootstrapApp.js';
import {
  ChatSessionController,
  type ChatSessionControllerOptions,
} from '../../src/session/ChatSessionController.js';
import type { RestoredSession } from '../../src/session/SessionRestore.js';
import { SessionQueueStore } from '../../src/app/session/SessionQueueStore.js';
import type { AppProps } from '../../src/tui/App.js';
import { createTempWorkspace, writeAgentConfig } from '../helpers/tempConfig.js';

describe('bootstrapApp task09 resume 编排', () => {
  it('AC7: project-rules 加载后再初始化恢复上下文，并在 render 前完成全部接线', async () => {
    const workspace = await createTempWorkspace();
    const events: string[] = [];
    const restored = createRestoredSession();
    let capturedOptions: ChatSessionControllerOptions | undefined;
    let archiveResume: unknown;
    await writeAgentConfig(
      workspace.project,
      `
protocol: openai
model: gpt-4.1
base_url: https://api.openai.com/v1
api_key: sk-test-bootstrap-resume
`,
    );
    await writeFile(join(workspace.project, 'AGENTCODE.md'), 'TASK09_RULE_MARKER', 'utf8');

    const contextManager = {
      onTokenUsage: () => undefined,
      onMessagesAppended: () => {
        const rules = capturedOptions?.systemPromptRegistry?.find((module) => module.id === 'project-rules');
        expect(rules?.content).toContain('TASK09_RULE_MARKER');
        events.push('context-appended');
      },
      offloadToolResults: async () => undefined,
      compact: async () => ({ outcome: 'skipped', reason: 'below_threshold', attempts: 0 }),
    } as any;
    const dependencies: BootstrapDependencies = {
      pickSession: async () => {
        events.push('session-picked');
        return restored;
      },
      maybeClean: async () => undefined,
      createSessionArchive: (options) => {
        archiveResume = options.resume;
        return { append: async () => undefined };
      },
      createAutoNoteWriter: () => ({ maybeUpdate: async () => undefined }),
      createController: (options) => {
        capturedOptions = options;
        events.push('controller-created');
        return new ChatSessionController({ ...options, contextManager });
      },
    };

    try {
      await bootstrapApp(
        {
          cwd: workspace.project,
          homeDir: workspace.home,
          resumeMode: true,
          renderApp: (node) => {
            expect(React.isValidElement(node)).toBe(true);
            events.push('render');
            return createFakeInkInstance();
          },
        },
        dependencies,
      );

      expect(capturedOptions?.initialProviderContext).toEqual(restored.providerContext);
      expect(capturedOptions?.initialMessages).toEqual(restored.messages);
      expect(archiveResume).toEqual({
        sessionId: '20260102-030405-abcd',
        repairOffset: 123,
        expectedFile: { size: 456, mtimeMs: 789, dev: 1, ino: 2 },
      });
      expect(events).toEqual(['session-picked', 'controller-created', 'context-appended', 'render']);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('无 resumeMode 时不调用选择器，清理器保持 fire-and-forget', async () => {
    const workspace = await createTempWorkspace();
    const pickSession = vi.fn(async () => createRestoredSession());
    const cleanerGate = new Promise<void>(() => undefined);
    let capturedOptions: ChatSessionControllerOptions | undefined;
    await writeAgentConfig(
      workspace.project,
      `
protocol: openai
model: gpt-4.1
base_url: https://api.openai.com/v1
api_key: sk-test-bootstrap-new
`,
    );

    try {
      await bootstrapApp(
        {
          cwd: workspace.project,
          homeDir: workspace.home,
          renderApp: () => createFakeInkInstance(),
        },
        {
          pickSession,
          maybeClean: () => cleanerGate,
          createSessionArchive: () => ({ append: async () => undefined }),
          createAutoNoteWriter: () => ({ maybeUpdate: async () => undefined }),
          createController: (options) => {
            capturedOptions = options;
            return new ChatSessionController(options);
          },
        },
      );

      expect(pickSession).not.toHaveBeenCalled();
      expect(capturedOptions?.initialProviderContext).toBeUndefined();
      expect(capturedOptions?.initialMessages).toBeUndefined();
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('从项目子目录启动时仍把根目录用于规则和会话持久化', async () => {
    const workspace = await createTempWorkspace();
    let loadedCwd: string | undefined;
    let sessionsDir: string | undefined;
    await writeAgentConfig(
      workspace.project,
      `
protocol: openai
model: gpt-4.1
base_url: https://api.openai.com/v1
api_key: sk-test-bootstrap-nested
`,
    );
    try {
      await bootstrapApp(
        {
          cwd: workspace.nestedProjectDirectory,
          homeDir: workspace.home,
          renderApp: () => createFakeInkInstance(),
        },
        {
          loadDynamicModules: async (cwd) => {
            loadedCwd = cwd;
            return [];
          },
          maybeClean: async () => undefined,
          createSessionArchive: (options) => {
            sessionsDir = options.sessionsDir;
            return { append: async () => undefined };
          },
          createAutoNoteWriter: () => ({ maybeUpdate: async () => undefined }),
        },
      );

      expect(loadedCwd).toBe(workspace.project);
      expect(sessionsDir).toBe(join(workspace.project, '.agentcode', 'sessions'));
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('restores the session Queue as paused without automatically starting it', async () => {
    const workspace = await createTempWorkspace();
    const restored = createRestoredSession();
    const queue = await SessionQueueStore.open({
      storageRoot: workspace.project,
      sessionId: restored.source!.sessionId,
    });
    await queue.add('pending after restart', 'plan');
    let renderedNode: React.ReactElement<AppProps> | undefined;
    await writeAgentConfig(
      workspace.project,
      `
protocol: openai
model: gpt-4.1
base_url: https://api.openai.com/v1
api_key: sk-test-bootstrap-queue
`,
    );

    try {
      await bootstrapApp(
        {
          cwd: workspace.project,
          homeDir: workspace.home,
          resumeMode: true,
          renderApp: (node) => {
            if (React.isValidElement<AppProps>(node)) renderedNode = node;
            return createFakeInkInstance();
          },
        },
        {
          pickSession: async () => restored,
          maybeClean: async () => undefined,
          createSessionArchive: () => ({ append: async () => undefined }),
          createAutoNoteWriter: () => ({ maybeUpdate: async () => undefined }),
        },
      );

      expect(renderedNode?.props.runtime.getSnapshot()).toMatchObject({
        session: { id: restored.source!.sessionId, resumed: true },
        queue: { count: 1, paused: true, draining: false },
      });
      expect(queue.snapshot().items[0]).toMatchObject({ text: 'pending after restart', agentMode: 'plan' });
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('treats command registry startup conflicts as fatal before rendering', async () => {
    const workspace = await createTempWorkspace();
    const renderApp = vi.fn(() => createFakeInkInstance());
    await writeAgentConfig(
      workspace.project,
      `
protocol: openai
model: gpt-4.1
base_url: https://api.openai.com/v1
api_key: sk-test-bootstrap-registry
`,
    );

    try {
      await expect(bootstrapApp(
        {
          cwd: workspace.project,
          homeDir: workspace.home,
          renderApp,
        },
        {
          createCommandRegistry: () => {
            throw new Error('command registry conflict');
          },
        },
      )).rejects.toThrow('command registry conflict');
      expect(renderApp).not.toHaveBeenCalled();
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });
});

function createRestoredSession(): RestoredSession {
  return {
    providerContext: [
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
    ],
    messages: [
      { id: 'old-user', role: 'user', parts: [{ type: 'text', text: '历史问题' }], createdAt: 1 },
      { id: 'old-agent', role: 'assistant', parts: [{ type: 'text', text: '历史回答' }], createdAt: 2 },
    ],
    source: {
      sessionId: '20260102-030405-abcd',
      filePath: '/project/.agentcode/sessions/20260102-030405-abcd.jsonl',
      repairOffset: 123,
      expectedFile: { size: 456, mtimeMs: 789, dev: 1, ino: 2 },
    },
  };
}

function createFakeInkInstance(): import('ink').Instance {
  return {
    rerender: () => undefined,
    unmount: () => undefined,
    waitUntilExit: async () => undefined,
    cleanup: () => undefined,
    clear: () => undefined,
  };
}
