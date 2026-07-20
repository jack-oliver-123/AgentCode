import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRuntime } from '../../../src/app/runtime/AppRuntime.js';
import {
  AppSessionRuntime,
  type RuntimeSessionController,
} from '../../../src/app/runtime/AppSessionRuntime.js';
import { SessionWorkspace } from '../../../src/app/session/SessionWorkspace.js';
import type { AgentMode } from '../../../src/app/runtime/types.js';
import type { RecordedSteerAcceptance, SessionControlAcceptance } from '../../../src/session/ChatSessionController.js';
import type { ChatSessionEvent, ChatSessionState } from '../../../src/session/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AppSessionRuntime', () => {
  it('persists Queue input before acceptance and drains it in FIFO order', async () => {
    const harness = await createHarness();

    await expect(harness.sessions.queueAdd('first task')).resolves.toEqual({ accepted: true });
    await waitFor(() => harness.controller.submitted.length === 1);
    expect(harness.workspace.getActiveQueue().snapshot().items).toMatchObject([
      { text: 'first task', status: 'running', agentMode: 'default' },
    ]);

    harness.controller.release();
    await waitFor(() => harness.workspace.getActiveQueue().snapshot().items.length === 0);
    expect(harness.workspace.getActiveSnapshot().turnCount).toBe(1);
    expect(harness.runtime.getSnapshot().queue).toMatchObject({ count: 0, draining: false });
    await harness.workspace.close();
  });

  it('returns from queueRun before the turn completes and executes the frozen Agent mode', async () => {
    const onAgentModeChanged = vi.fn(async () => undefined);
    const harness = await createHarness({ onAgentModeChanged });
    await harness.workspace.getActiveQueue().pause();
    harness.sessions.publishCurrentState();
    await harness.sessions.setAgentMode('plan');
    await harness.sessions.queueAdd('planned task');
    await harness.sessions.setAgentMode('default');

    const run = harness.sessions.queueRun();
    await expect(run).resolves.toBeUndefined();
    await waitFor(() => harness.controller.submitted.length === 1);

    expect(harness.controller.submitted).toEqual([{ text: 'planned task', mode: 'plan' }]);
    expect(harness.workspace.getActiveSnapshot().agentMode).toBe('plan');
    expect(onAgentModeChanged).toHaveBeenLastCalledWith('plan');
    harness.controller.release();
    await waitFor(() => harness.workspace.getActiveQueue().snapshot().items.length === 0);
    await harness.workspace.close();
  });

  it('keeps a persisted item and pauses Queue when starting the turn fails', async () => {
    const harness = await createHarness({ failText: 'broken task' });

    await expect(harness.sessions.queueAdd('broken task')).resolves.toEqual({ accepted: true });
    await waitFor(() => harness.workspace.getActiveQueue().snapshot().paused);

    expect(harness.workspace.getActiveQueue().snapshot().items).toMatchObject([
      { text: 'broken task', status: 'queued' },
    ]);
    expect(harness.runtime.getSnapshot().commandOutputs.at(-1)?.content).toContain('Queue drain paused');
    await harness.workspace.close();
  });

  it('does not start queued work concurrently with Review and drains after Review succeeds', async () => {
    const harness = await createHarness();
    harness.runtime.dispatch({ type: 'review.started', runId: 'review-1' });

    await harness.sessions.queueAdd('after review');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.controller.submitted).toEqual([]);
    expect(harness.workspace.getActiveQueue().snapshot().items).toMatchObject([{ text: 'after review', status: 'queued' }]);

    harness.runtime.dispatch({ type: 'review.finished' });
    harness.sessions.drainQueueIfReady();
    await waitFor(() => harness.controller.submitted.length === 1);
    harness.controller.release();
    await waitFor(() => harness.workspace.getActiveQueue().snapshot().items.length === 0);
    await harness.workspace.close();
  });

  it('pauses Queue during Stop even if the controller publishes an idle final state', async () => {
    const harness = await createHarness({ stopEndsIdle: true });
    await expect(harness.sessions.submitPrompt('active task')).resolves.toEqual({ accepted: true });
    await expect(harness.sessions.queueAdd('must remain queued')).resolves.toEqual({ accepted: true });

    await expect(harness.sessions.stopRun()).resolves.toEqual({ accepted: true });

    expect(harness.controller.submitted).toEqual([{ text: 'active task', mode: 'default' }]);
    expect(harness.workspace.getActiveQueue().snapshot()).toMatchObject({
      paused: true,
      items: [{ text: 'must remain queued', status: 'queued' }],
    });
    await harness.workspace.close();
  });
});

async function createHarness(options: {
  failText?: string;
  stopEndsIdle?: boolean;
  onAgentModeChanged?: (mode: AgentMode) => void | Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentcode-app-session-'));
  roots.push(root);
  let controller: ControlledController | undefined;
  const workspace = await SessionWorkspace.open<ControlledController>({
    storageRoot: root,
    selectedPermissionMode: 'normal',
    createSessionId: () => 'session-a',
    createController: ({ session }) => {
      controller = new ControlledController(session.agentMode, options.failText, options.stopEndsIdle ?? false);
      return controller;
    },
  });
  const runtime = new AppRuntime({
    mode: workspace.getActiveSnapshot().agentMode,
    session: workspace.getActiveSnapshot(),
    chat: workspace.getActiveController().getState(),
  });
  const sessions = new AppSessionRuntime(runtime, workspace, {
    ...(options.onAgentModeChanged !== undefined ? { onAgentModeChanged: options.onAgentModeChanged } : {}),
  });
  return { root, workspace, runtime, sessions, controller: controller! };
}

class ControlledController implements RuntimeSessionController {
  readonly submitted: Array<{ text: string; mode: AgentMode }> = [];
  private state: ChatSessionState;
  private activeRunId: string | undefined;
  private releaseTurn: (() => void) | undefined;
  private stopped = false;

  constructor(
    mode: AgentMode,
    private readonly failText?: string,
    private readonly stopEndsIdle = false,
  ) {
    this.state = { messages: [], status: 'idle', mode };
  }

  getState(): ChatSessionState {
    return structuredClone(this.state);
  }

  getActiveRun(): { id: string; phase: 'streaming' } | undefined {
    return this.activeRunId === undefined ? undefined : { id: this.activeRunId, phase: 'streaming' };
  }

  async *submitUserText(text: string): AsyncIterable<ChatSessionEvent> {
    if (text === this.failText) throw new Error('start failed');
    this.submitted.push({ text, mode: this.state.mode });
    this.activeRunId = `run-${this.submitted.length}`;
    this.state = { ...this.state, status: 'streaming' };
    yield { type: 'state.changed', state: this.getState() };
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
    this.activeRunId = undefined;
    this.state = { ...this.state, status: this.stopped && !this.stopEndsIdle ? 'stopped' : 'idle' };
    this.stopped = false;
    yield { type: 'state.changed', state: this.getState() };
  }

  release(): void {
    this.releaseTurn?.();
    this.releaseTurn = undefined;
  }

  async steer(): Promise<SessionControlAcceptance> {
    return this.activeRunId === undefined ? { accepted: false, reason: 'no_active_run' } : { accepted: true };
  }

  async recordExternalSteer(_runId: string, text: string): Promise<RecordedSteerAcceptance> {
    return {
      accepted: true,
      guidance: { id: 'steer-1', text, createdAt: 1 },
    };
  }

  async stopRun(): Promise<SessionControlAcceptance> {
    if (this.activeRunId === undefined) return { accepted: false, reason: 'no_active_run' };
    this.stopped = true;
    this.release();
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
    return { estimatedTokens: 0, contextWindow: 1_000, compaction: 'ready' };
  }

  async persistReviewResult(): Promise<void> {}

  close(): void {}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
