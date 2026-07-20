import { describe, expect, it } from 'vitest';

import { AppRuntime } from '../../../src/app/runtime/AppRuntime.js';
import type { AppEvent } from '../../../src/app/runtime/types.js';

describe('AppRuntime', () => {
  it('reduces all app events through one ordered snapshot stream', () => {
    const runtime = new AppRuntime({ mode: 'default' });
    const observed: Array<{ revision: number; event: AppEvent['type'] }> = [];
    runtime.subscribe((snapshot, event) => {
      observed.push({ revision: snapshot.revision, event: event.type });
    });

    runtime.dispatch({
      type: 'notice.shown',
      notice: { id: 'notice-1', level: 'info', text: 'ready' },
    });
    runtime.dispatch({
      type: 'panel.opened',
      panel: { id: 'panel-1', kind: 'status', title: 'Status', data: { provider: 'ok' } },
    });
    runtime.dispatch({ type: 'mode.changed', mode: 'plan' });
    runtime.dispatch({
      type: 'session.activated',
      session: {
        id: 'session-2',
        name: 'next',
        createdAt: 10,
        updatedAt: 20,
        turnCount: 0,
        resumed: false,
        agentMode: 'default',
        selectedPermissionMode: 'normal',
        archivePath: '/tmp/session-2.jsonl',
      },
    });

    expect(observed).toEqual([
      { revision: 1, event: 'notice.shown' },
      { revision: 2, event: 'panel.opened' },
      { revision: 3, event: 'mode.changed' },
      { revision: 4, event: 'session.activated' },
    ]);
    expect(runtime.getSnapshot()).toMatchObject({
      revision: 4,
      mode: 'default',
      displayMode: 'default',
      session: { id: 'session-2', name: 'next', agentMode: 'default' },
    });
    expect(runtime.getSnapshot().notice).toBeUndefined();
    expect(runtime.getSnapshot().panel).toBeUndefined();
    expect(runtime.getSnapshot().commandOutputs).toEqual([]);
  });

  it('keeps command errors independent from agent/provider errors', () => {
    const runtime = new AppRuntime({ mode: 'default' });

    runtime.dispatch({
      type: 'agent.error',
      error: { code: 'provider_error', message: 'provider unavailable', retryable: true },
    });
    runtime.dispatch({
      type: 'command.error',
      error: { code: 'unknown_command', message: 'unknown /stats', at: 100 },
    });

    expect(runtime.getSnapshot().agentError?.message).toBe('provider unavailable');
    expect(runtime.getSnapshot().commandError?.message).toBe('unknown /stats');

    runtime.dispatch({ type: 'command.error.cleared' });
    expect(runtime.getSnapshot().commandError).toBeUndefined();
    expect(runtime.getSnapshot().agentError?.message).toBe('provider unavailable');
  });

  it('updates same-session metadata without clearing transient command UI', () => {
    const session = {
      id: 'session-1',
      createdAt: 1,
      updatedAt: 1,
      turnCount: 0,
      resumed: false,
      agentMode: 'default' as const,
      selectedPermissionMode: 'normal' as const,
      archivePath: '/tmp/session-1.jsonl',
    };
    const runtime = new AppRuntime({ mode: 'default', session });
    runtime.dispatch({
      type: 'panel.opened',
      panel: { id: 'panel-1', kind: 'status', title: 'Status', data: {} },
    });
    runtime.dispatch({
      type: 'command.output.appended',
      output: { id: 'output-1', command: 'status', content: 'ok', createdAt: 1 },
    });

    runtime.dispatch({
      type: 'session.updated',
      session: { ...session, updatedAt: 2, turnCount: 1 },
      queue: { count: 1, paused: true, draining: false, version: 2 },
    });

    expect(runtime.getSnapshot()).toMatchObject({
      session: { id: 'session-1', updatedAt: 2, turnCount: 1 },
      panel: { id: 'panel-1' },
      commandOutputs: [{ id: 'output-1' }],
      queue: { count: 1, paused: true },
    });
  });

  it('serializes reentrant dispatches instead of publishing competing states', () => {
    const runtime = new AppRuntime({ mode: 'default' });
    const observed: string[] = [];

    runtime.subscribe((_snapshot, event) => {
      observed.push(event.type);
      if (event.type === 'notice.shown') {
        runtime.dispatch({ type: 'mode.changed', mode: 'plan' });
      }
    });

    runtime.dispatch({
      type: 'notice.shown',
      notice: { id: 'notice-1', level: 'info', text: 'switch next' },
    });

    expect(observed).toEqual(['notice.shown', 'mode.changed']);
    expect(runtime.getSnapshot()).toMatchObject({ revision: 2, mode: 'plan' });
  });

  it('publishes immutable snapshots', () => {
    const runtime = new AppRuntime({ mode: 'default' });
    const snapshot = runtime.getSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.run)).toBe(true);
    expect(Object.isFrozen(snapshot.queue)).toBe(true);
  });
});
