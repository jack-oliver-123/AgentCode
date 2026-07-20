import { describe, expect, it, vi } from 'vitest';

import { InteractionCoordinator } from '../../../src/app/interaction/InteractionCoordinator.js';
import type { MemoryManager } from '../../../src/app/memory/MemoryManager.js';
import type { PermissionManager } from '../../../src/app/permissions/PermissionManager.js';
import type { ReviewRunner } from '../../../src/app/review/ReviewRunner.js';
import type { FrozenReviewTarget } from '../../../src/app/review/targetFreeze.js';
import { AppCommandExecutor } from '../../../src/app/runtime/AppCommandExecutor.js';
import { AppRuntime } from '../../../src/app/runtime/AppRuntime.js';
import type { AppSessionRuntime, RuntimeSessionController } from '../../../src/app/runtime/AppSessionRuntime.js';
import type { SessionWorkspace } from '../../../src/app/session/SessionWorkspace.js';
import type { CommandContext } from '../../../src/commands/context.js';
import type { CommandAction, CommandOperation } from '../../../src/commands/types.js';

const target: FrozenReviewTarget = {
  kind: 'worktree',
  input: { kind: 'worktree' },
  repoRoot: 'C:\repo',
  baseSha: 'head',
  headSha: 'head',
  diff: '+bug',
  diffHash: 'a'.repeat(64),
  metadata: {},
  frozenAt: 1,
};

describe('AppCommandExecutor review lifecycle', () => {
  it('starts Review asynchronously, accepts Review Steer, and Stop restores the prior mode', async () => {
    const runtime = new AppRuntime({ mode: 'plan', session: sessionSnapshot() });
    const setModeCap = vi.fn(async () => permissionSnapshot());
    const permissions = {
      snapshot: permissionSnapshot,
      setModeCap,
    } as unknown as PermissionManager;
    const recordExternalSteer = vi.fn(async (_runId: string, text: string) => ({
      id: 'steer-1',
      text,
      createdAt: 2,
    }));
    const pauseQueue = vi.fn(async () => undefined);
    const sessions = { recordExternalSteer, pauseQueue } as unknown as AppSessionRuntime;
    const workspace = {
      getActiveSnapshot: sessionSnapshot,
    } as unknown as SessionWorkspace<RuntimeSessionController>;
    let capturedSignal: AbortSignal | undefined;
    let consumeSteer: (() => readonly { id: string; text: string; createdAt: number }[]) | undefined;
    const reviewRunner = {
      run: vi.fn(async (_target: FrozenReviewTarget, signal?: AbortSignal, consume?: typeof consumeSteer) => {
        capturedSignal = signal;
        consumeSteer = consume;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }),
    } as unknown as ReviewRunner;
    const interactions = new InteractionCoordinator({
      getState: () => ({
        sessionId: 'session-a',
        activeRunExists: runtime.getSnapshot().run.phase !== 'idle',
        agentMode: runtime.getSnapshot().mode,
        reviewActive: runtime.getSnapshot().run.reviewActive,
      }),
      execute: async () => undefined,
    });
    const executor = new AppCommandExecutor({
      runtime,
      sessions,
      workspace,
      interactions,
      permissions,
      memory: {} as MemoryManager,
      freezeReviewTarget: async () => target,
      reviewRunner,
      now: () => 10,
    });
    const action: CommandAction = {
      type: 'start_review',
      idempotencyKey: 'review-1',
      target: { kind: 'worktree' },
    };
    const operation: CommandOperation = { kind: 'review.worktree' };
    const context = commandContext(runtime);

    await executor.preflight(action, context, operation);
    await expect(executor.commit(action, context, operation)).resolves.toBeUndefined();
    expect(runtime.getSnapshot()).toMatchObject({
      mode: 'plan',
      displayMode: 'review',
      run: { id: 'review-1', phase: 'streaming', reviewActive: true },
    });
    expect(capturedSignal?.aborted).toBe(false);

    await executor.commit(
      { type: 'steer', idempotencyKey: 'review-steer', text: 'check the race' },
      context,
      { kind: 'steer' },
    );
    expect(recordExternalSteer).toHaveBeenCalledWith('review-1', 'check the race');
    expect(consumeSteer?.()).toEqual([{ id: 'steer-1', text: 'check the race', createdAt: 2 }]);

    await executor.commit(
      { type: 'stop_run', idempotencyKey: 'review-stop' },
      context,
      { kind: 'stop' },
    );
    await waitFor(() => runtime.getSnapshot().run.reviewActive === false);
    expect(capturedSignal?.aborted).toBe(true);
    expect(pauseQueue).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot()).toMatchObject({ mode: 'plan', displayMode: 'plan' });
    expect(runtime.getSnapshot().notice?.text).toBe('Review stopped.');
    expect(setModeCap).toHaveBeenCalledWith({ agentMode: 'plan', reviewActive: true });
    expect(setModeCap).toHaveBeenCalledWith({ agentMode: 'plan', reviewActive: false });
  });
});

function commandContext(runtime: AppRuntime): CommandContext {
  return {
    executionId: 'command-1',
    app: runtime.getSnapshot(),
    session: sessionSnapshot(),
    sessions: [],
    queue: { sessionId: 'session-a', version: 0, paused: false, restored: false, items: [] },
    permissions: permissionSnapshot(),
    permissionRules: [],
    memory: {
      user: [],
      project: [],
      status: {
        autoNotesEnabled: false,
        counts: { user: 0, project: 0 },
        indexPaths: { user: '', project: '' },
        storagePaths: { user: '', project: '' },
      },
    },
    status: undefined,
  };
}

function sessionSnapshot() {
  return {
    id: 'session-a',
    createdAt: 1,
    updatedAt: 1,
    turnCount: 0,
    resumed: false,
    agentMode: 'plan' as const,
    selectedPermissionMode: 'normal' as const,
    archivePath: 'C:\repo\.agentcode\sessions\session-a.jsonl',
  };
}

function permissionSnapshot() {
  return {
    selectedMode: 'normal' as const,
    effectiveMode: 'readonly' as const,
    generation: 1,
    counts: { session: 0, project: 0, global: 0 },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
