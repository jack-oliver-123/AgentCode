import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { bootstrapApp, type BootstrapDependencies } from '../../../src/app/bootstrapApp.js';
import type { RecordedSteerAcceptance, SessionControlAcceptance } from '../../../src/session/ChatSessionController.js';
import { SessionArchive } from '../../../src/session/SessionArchive.js';
import type { ChatSessionEvent, ChatSessionState } from '../../../src/session/types.js';
import type { ReviewRunner } from '../../../src/app/review/ReviewRunner.js';
import type { FrozenReviewTarget } from '../../../src/app/review/targetFreeze.js';
import type { RuntimeSessionController } from '../../../src/app/runtime/AppSessionRuntime.js';
import type { AgentMode } from '../../../src/app/runtime/types.js';
import type { AppProps } from '../../../src/tui/App.js';
import { createTempWorkspace, writeAgentConfig } from '../../helpers/tempConfig.js';

const frozenTarget: FrozenReviewTarget = {
  kind: 'worktree',
  input: { kind: 'worktree' },
  repoRoot: 'C:\repo',
  baseSha: 'head',
  headSha: 'head',
  diff: '+bug',
  diffHash: 'b'.repeat(64),
  metadata: {},
  frozenAt: 1,
};

describe('Task 10 command framework integration', () => {
  it('runs Steer/Queue/Status/Stop/Review/Clear and restores the old paused Queue', async () => {
    const workspace = await createTempWorkspace();
    const controllers: ControlledController[] = [];
    let appProps: AppProps | undefined;
    await writeAgentConfig(
      workspace.project,
      `
protocol: openai
model: gpt-4.1
base_url: https://api.openai.com/v1
api_key: sk-test-command-framework
`,
    );
    const dependencies: BootstrapDependencies = {
      maybeClean: async () => undefined,
      createAutoNoteWriter: () => ({ maybeUpdate: async () => undefined }),
      createController: (options) => {
        const controller = new ControlledController(options.agentMode ?? 'default');
        controllers.push(controller);
        return controller;
      },
      freezeReviewTarget: async () => frozenTarget,
      createReviewRunner: (options) => ({
        run: vi.fn(async () => {
          const result = { target: frozenTarget, findings: [], summary: '未发现符合报告阈值的问题。' };
          await options.persistResult(result);
          return result;
        }),
      }) as unknown as ReviewRunner,
    };

    try {
      await bootstrapApp(
        {
          cwd: workspace.project,
          homeDir: workspace.home,
          renderApp: (node) => {
            if (React.isValidElement<AppProps>(node)) appProps = node.props;
            return fakeInkInstance();
          },
        },
        dependencies,
      );
      if (appProps === undefined) throw new Error('App was not rendered.');
      const oldSessionId = appProps.runtime.getSnapshot().session!.id;
      const first = controllers[0]!;

      expect(await appProps.inputRouter.route('initial task', 'enter')).toMatchObject({
        kind: 'prompt', accepted: true, clearInput: true,
      });
      await waitFor(() => first.submitted.length === 1);
      expect(await appProps.inputRouter.route('focus on the race', 'enter')).toMatchObject({
        kind: 'steer', accepted: true, clearInput: true,
      });
      expect(first.steers).toEqual(['focus on the race']);
      expect(await appProps.inputRouter.route('queued follow-up', 'alt-enter')).toMatchObject({
        kind: 'queue', accepted: true, clearInput: true,
      });

      expect(await appProps.inputRouter.route('/status', 'enter')).toMatchObject({ kind: 'command', accepted: true });
      expect(appProps.runtime.getSnapshot().panel?.kind).toBe('status');
      expect(first.submitted).toHaveLength(1);

      expect(await appProps.inputRouter.route('/stop', 'enter')).toMatchObject({ kind: 'command', accepted: true });
      await waitFor(() => appProps!.runtime.getSnapshot().queue.paused);
      expect(appProps.runtime.getSnapshot().queue.count).toBe(1);

      expect(await appProps.inputRouter.route('/queue run', 'enter')).toMatchObject({ kind: 'command', accepted: true });
      await waitFor(() => first.submitted.length >= 2).catch(() => {
        throw new Error(`Queue did not restart: ${JSON.stringify({
          submitted: first.submitted,
          snapshot: appProps!.runtime.getSnapshot(),
        })}`);
      });
      expect(first.submitted[1]?.text).toBe('queued follow-up');
      expect(await appProps.inputRouter.route('keep this for later', 'alt-enter')).toMatchObject({
        kind: 'queue', accepted: true,
      });
      await appProps.inputRouter.route('/stop', 'enter');
      await waitFor(() => {
        const queue = appProps!.runtime.getSnapshot().queue;
        return queue.paused && !queue.draining && queue.count >= 1;
      });
      const pausedCount = appProps.runtime.getSnapshot().queue.count;

      expect(await appProps.inputRouter.route('/review', 'enter')).toMatchObject({ kind: 'command', accepted: true });
      await waitFor(() => appProps!.runtime.getSnapshot().panel?.kind === 'review');
      expect(appProps.runtime.getSnapshot()).toMatchObject({ displayMode: 'default', run: { reviewActive: false } });
      expect(first.reviewResults).toHaveLength(1);

      expect(await appProps.inputRouter.route('/clear "next"', 'enter')).toMatchObject({
        kind: 'command', accepted: true,
      });
      const newSessionId = appProps.runtime.getSnapshot().session!.id;
      expect(newSessionId).not.toBe(oldSessionId);
      expect(appProps.runtime.getSnapshot()).toMatchObject({
        mode: 'default',
        queue: { count: 0, paused: false },
        chat: { messages: [] },
      });

      const archive = new SessionArchive({
        sessionsDir: join(workspace.project, '.agentcode', 'sessions'),
        resume: { sessionId: oldSessionId },
      });
      await archive.append([
        { role: 'user', content: 'archived task' },
        { role: 'assistant', content: 'archived response' },
      ]);

      expect(await appProps.inputRouter.route('/session', 'enter')).toMatchObject({ kind: 'command', accepted: true });
      const interaction = appProps.runtime.getSnapshot().interaction;
      expect(interaction?.kind).toBe('session-picker');
      await appProps.interactionCoordinator!.settle(interaction!.id, { kind: 'selected', value: oldSessionId });

      expect(appProps.runtime.getSnapshot()).toMatchObject({
        session: { id: oldSessionId, resumed: true },
        queue: { count: pausedCount, paused: true, draining: false },
      });
      expect(appProps.runtime.getSnapshot().interaction).toBeUndefined();
    } finally {
      await appProps?.onDispose?.();
      await rm(workspace.root, { recursive: true, force: true });
    }
  }, 20_000);
});

class ControlledController implements RuntimeSessionController {
  readonly submitted: Array<{ text: string; mode: AgentMode }> = [];
  readonly steers: string[] = [];
  readonly reviewResults: unknown[] = [];
  private state: ChatSessionState;
  private activeRunId: string | undefined;
  private releaseTurn: (() => void) | undefined;
  private stopped = false;

  constructor(mode: AgentMode) {
    this.state = { messages: [], status: 'idle', mode };
  }

  getState(): ChatSessionState {
    return structuredClone(this.state);
  }

  getActiveRun(): { id: string; phase: 'streaming' } | undefined {
    return this.activeRunId === undefined ? undefined : { id: this.activeRunId, phase: 'streaming' };
  }

  async *submitUserText(text: string): AsyncIterable<ChatSessionEvent> {
    this.submitted.push({ text, mode: this.state.mode });
    this.activeRunId = `run-${this.submitted.length}`;
    this.state = { ...this.state, status: 'streaming' };
    yield { type: 'state.changed', state: this.getState() };
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
    this.activeRunId = undefined;
    this.state = { ...this.state, status: this.stopped ? 'stopped' : 'idle' };
    this.stopped = false;
    yield { type: 'state.changed', state: this.getState() };
  }

  async steer(text: string): Promise<SessionControlAcceptance> {
    if (this.activeRunId === undefined) return { accepted: false, reason: 'no_active_run' };
    this.steers.push(text);
    return { accepted: true };
  }

  async recordExternalSteer(_runId: string, text: string): Promise<RecordedSteerAcceptance> {
    return { accepted: true, guidance: { id: `steer-${this.steers.length + 1}`, text, createdAt: Date.now() } };
  }

  async stopRun(): Promise<SessionControlAcceptance> {
    if (this.activeRunId === undefined) return { accepted: false, reason: 'no_active_run' };
    this.stopped = true;
    this.releaseTurn?.();
    this.releaseTurn = undefined;
    return { accepted: true };
  }

  setAgentMode(mode: AgentMode): ChatSessionEvent {
    this.state = { ...this.state, mode };
    return { type: 'state.changed', state: this.getState() };
  }

  async *compactContext(): AsyncIterable<ChatSessionEvent> {
    yield { type: 'state.changed', state: this.getState() };
  }

  getContextStatus() {
    return { estimatedTokens: 10, contextWindow: 1_000, compaction: 'ready' };
  }

  async persistReviewResult(_reviewId: string, content: unknown): Promise<void> {
    this.reviewResults.push(content);
  }

  close(): void {}
}

function fakeInkInstance(): import('ink').Instance {
  return {
    rerender: () => undefined,
    unmount: () => undefined,
    waitUntilExit: async () => undefined,
    cleanup: () => undefined,
    clear: () => undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for command-framework state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
