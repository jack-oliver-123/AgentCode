import { describe, expect, it, vi } from 'vitest';

import {
  InteractionCoordinator,
  InteractionExpiredError,
  type InteractionRuntimeState,
} from '../../../src/app/interaction/InteractionCoordinator.js';

function createState(): InteractionRuntimeState {
  return {
    sessionId: 'session-a',
    activeRunExists: false,
    agentMode: 'default',
    reviewActive: false,
  };
}

describe('InteractionCoordinator', () => {
  it('generates typed request IDs and settles the same request at most once', async () => {
    let state = createState();
    const execute = vi.fn(async () => ({ deleted: true }));
    const coordinator = new InteractionCoordinator({
      getState: () => state,
      execute,
      createId: () => 'interaction-1',
      now: () => 100,
    });
    const request = coordinator.request({
      kind: 'confirm-memory-delete',
      idempotencyKey: 'memory-delete-1',
      sessionId: 'session-a',
      operation: 'memory.delete',
      activeRunPolicy: 'immediate',
      allowedInReadonly: true,
      scope: 'project',
      entry: 'one.md',
      fingerprint: 'abc',
    });

    expect(request).toMatchObject({ id: 'interaction-1', createdAt: 100, kind: 'confirm-memory-delete' });
    const [first, duplicate] = await Promise.all([
      coordinator.settle(request.id, { kind: 'confirmed' }),
      coordinator.settle(request.id, { kind: 'confirmed' }),
    ]);

    expect(first).toEqual({ kind: 'completed', value: { deleted: true } });
    expect(duplicate).toEqual(first);
    expect(execute).toHaveBeenCalledOnce();
    expect(coordinator.listPending()).toEqual([]);
    state = { ...state };
  });

  it('rejects settlement after the active session changes', async () => {
    let state = createState();
    const execute = vi.fn();
    const coordinator = new InteractionCoordinator({ getState: () => state, execute });
    const request = coordinator.request({
      kind: 'session-picker',
      idempotencyKey: 'picker-1',
      sessionId: 'session-a',
      operation: 'session.resume',
      activeRunPolicy: 'reject',
      allowedInReadonly: false,
      choices: [],
    });
    state = { ...state, sessionId: 'session-b' };

    await expect(coordinator.settle(request.id, { kind: 'selected', value: 'session-c' })).rejects.toBeInstanceOf(
      InteractionExpiredError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('reapplies operation policy and readonly mode limits at confirmation time', async () => {
    let state = createState();
    const execute = vi.fn(async () => 'done');
    const coordinator = new InteractionCoordinator({ getState: () => state, execute });
    const idleOnly = coordinator.request({
      kind: 'session-picker',
      idempotencyKey: 'idle-only',
      sessionId: 'session-a',
      operation: 'session.resume',
      activeRunPolicy: 'reject',
      allowedInReadonly: false,
      choices: [],
    });
    state = { ...state, activeRunExists: true };
    await expect(coordinator.settle(idleOnly.id, { kind: 'selected', value: 'session-b' })).rejects.toMatchObject({
      reason: 'active_run_policy_changed',
    });

    state = { ...createState(), agentMode: 'plan' };
    const dataPlane = coordinator.request({
      kind: 'session-picker',
      idempotencyKey: 'readonly-blocked',
      sessionId: 'session-a',
      operation: 'session.resume',
      activeRunPolicy: 'reject',
      allowedInReadonly: false,
      choices: [],
    });
    await expect(coordinator.settle(dataPlane.id, { kind: 'selected', value: 'session-b' })).rejects.toMatchObject({
      reason: 'readonly_cap_changed',
    });

    const controlPlane = coordinator.request({
      kind: 'confirm-queue-clear',
      idempotencyKey: 'readonly-allowed',
      sessionId: 'session-a',
      operation: 'queue.clear',
      activeRunPolicy: 'immediate',
      allowedInReadonly: true,
      queueVersion: 2,
    });
    await expect(coordinator.settle(controlPlane.id, { kind: 'confirmed' })).resolves.toEqual({
      kind: 'completed',
      value: 'done',
    });
  });

  it('rejects changed fingerprints before executing a side effect', async () => {
    const execute = vi.fn();
    const validateTarget = vi.fn(async () => false);
    const coordinator = new InteractionCoordinator({
      getState: createState,
      execute,
      validateTarget,
    });
    const request = coordinator.request({
      kind: 'confirm-memory-delete',
      idempotencyKey: 'memory-delete-1',
      sessionId: 'session-a',
      operation: 'memory.delete',
      activeRunPolicy: 'immediate',
      allowedInReadonly: true,
      scope: 'project',
      entry: 'one.md',
      fingerprint: 'old',
    });

    await expect(coordinator.settle(request.id, { kind: 'confirmed' })).rejects.toMatchObject({
      reason: 'target_changed',
    });
    expect(validateTarget).toHaveBeenCalledWith(request, createState());
    expect(execute).not.toHaveBeenCalled();
  });

  it('closes the modal after cancellation and target-validation failure', async () => {
    const onClosed = vi.fn();
    const coordinator = new InteractionCoordinator({
      getState: createState,
      execute: vi.fn(),
      validateTarget: async (request) => request.idempotencyKey !== 'changed',
      onClosed,
    });
    const cancelled = coordinator.request({
      kind: 'confirm-queue-clear',
      idempotencyKey: 'cancelled',
      sessionId: 'session-a',
      operation: 'queue.clear',
      activeRunPolicy: 'immediate',
      allowedInReadonly: true,
      queueVersion: 1,
    });
    const changed = coordinator.request({
      kind: 'confirm-memory-delete',
      idempotencyKey: 'changed',
      sessionId: 'session-a',
      operation: 'memory.delete',
      activeRunPolicy: 'immediate',
      allowedInReadonly: true,
      scope: 'project',
      entry: 'one.md',
      fingerprint: 'old',
    });

    await expect(coordinator.settle(cancelled.id, { kind: 'cancelled' })).resolves.toEqual({ kind: 'cancelled' });
    await expect(coordinator.settle(changed.id, { kind: 'confirmed' })).rejects.toMatchObject({
      reason: 'target_changed',
    });
    expect(onClosed).toHaveBeenCalledWith(cancelled);
    expect(onClosed).toHaveBeenCalledWith(changed);
  });

  it('deduplicates requests and side effects by idempotency key', async () => {
    const execute = vi.fn(async () => 42);
    let nextId = 0;
    const coordinator = new InteractionCoordinator({
      getState: createState,
      execute,
      createId: () => `interaction-${++nextId}`,
    });
    const input = {
      kind: 'confirm-queue-remove' as const,
      idempotencyKey: 'queue-remove-1',
      sessionId: 'session-a',
      operation: 'queue.remove',
      activeRunPolicy: 'immediate' as const,
      allowedInReadonly: true,
      index: 1,
      queueVersion: 3,
    };

    const first = coordinator.request(input);
    const duplicate = coordinator.request(input);
    expect(duplicate).toBe(first);
    expect(await coordinator.settle(first.id, { kind: 'confirmed' })).toEqual({ kind: 'completed', value: 42 });
    expect(await coordinator.settle(duplicate.id, { kind: 'confirmed' })).toEqual({ kind: 'completed', value: 42 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('expires pending tool approvals by run and ignores late responses safely', async () => {
    const execute = vi.fn();
    const coordinator = new InteractionCoordinator({ getState: createState, execute });
    const request = coordinator.request({
      kind: 'tool-approval',
      idempotencyKey: 'tool-approval-7',
      sessionId: 'session-a',
      operation: 'tool.approval',
      activeRunPolicy: 'immediate',
      allowedInReadonly: true,
      requestId: 7,
      runId: 'run-1',
      description: 'write file',
    });

    coordinator.expire((candidate) => candidate.kind === 'tool-approval' && candidate.runId === 'run-1', 'run_stopped');

    await expect(
      coordinator.settle(request.id, { kind: 'tool-approval', action: 'allow_once' }),
    ).rejects.toMatchObject({ reason: 'run_stopped' });
    expect(execute).not.toHaveBeenCalled();
  });
});
