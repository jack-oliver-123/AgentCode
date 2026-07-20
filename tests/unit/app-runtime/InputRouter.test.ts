import { describe, expect, it, vi } from 'vitest';

import { AppRuntime } from '../../../src/app/runtime/AppRuntime.js';
import { InputRouter, type RouteAcceptance } from '../../../src/app/runtime/InputRouter.js';
import { createBuiltinCommandRegistry } from '../../../src/commands/builtins/index.js';
import { CommandParser } from '../../../src/commands/parser.js';

function createHarness(active = false, draining = false, review = false) {
  const runtime = new AppRuntime({ mode: 'default' });
  if (active) {
    runtime.dispatch({ type: 'run.changed', run: { id: 'run-1', phase: 'streaming', reviewActive: review } });
  }
  if (draining) {
    runtime.dispatch({ type: 'queue.changed', queue: { count: 1, paused: false, draining: true, version: 1 } });
  }
  const dispatcher = {
    dispatch: vi.fn(async () => ({ kind: 'completed' as const, consumed: true as const, completed: [] })),
  };
  const workspace = {
    submitPrompt: vi.fn(async (): Promise<RouteAcceptance> => ({ accepted: true })),
    steer: vi.fn(async (): Promise<RouteAcceptance> => ({ accepted: true })),
    queueAdd: vi.fn(async (): Promise<RouteAcceptance> => ({ accepted: true })),
  };
  const complete = vi.fn((text: string, direction: 'next' | 'previous') => ({
    text: text === '/sta' ? '/status ' : text,
    candidates: ['status'],
    direction,
  }));
  const toggleMode = vi.fn(async () => ({ accepted: true as const }));
  const reviewSteer = vi.fn(async (): Promise<RouteAcceptance> => ({ accepted: true }));
  const router = new InputRouter({
    parser: new CommandParser(createBuiltinCommandRegistry()),
    dispatcher,
    workspace,
    reviewSteer,
    getAppSnapshot: runtime.getSnapshot,
    complete,
    toggleMode,
  });
  return { runtime, dispatcher, workspace, complete, toggleMode, reviewSteer, router };
}

describe('InputRouter', () => {
  it('routes slash input to the command dispatcher before any Agent path', async () => {
    const harness = createHarness();

    const result = await harness.router.route('/status', 'enter');

    expect(result).toMatchObject({ kind: 'command', accepted: true, clearInput: true });
    expect(harness.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(harness.workspace.submitPrompt).not.toHaveBeenCalled();
  });

  it('routes idle ordinary Enter to submitPrompt', async () => {
    const harness = createHarness();

    expect(await harness.router.route('hello', 'enter')).toMatchObject({
      kind: 'prompt',
      accepted: true,
      clearInput: true,
    });
    expect(harness.workspace.submitPrompt).toHaveBeenCalledWith('hello');
  });

  it('routes active Enter to Steer and active Alt+Enter to persistent Queue', async () => {
    const harness = createHarness(true);

    expect(await harness.router.route('guide this run', 'enter')).toMatchObject({ kind: 'steer', accepted: true });
    expect(await harness.router.route('future turn', 'alt-enter')).toMatchObject({ kind: 'queue', accepted: true });
    expect(harness.workspace.steer).toHaveBeenCalledWith('guide this run');
    expect(harness.workspace.queueAdd).toHaveBeenCalledWith('future turn');
  });

  it('routes ordinary Enter to the isolated Review Steer channel while Review is active', async () => {
    const harness = createHarness(true, false, true);

    expect(await harness.router.route('review this edge case', 'enter')).toMatchObject({
      kind: 'steer', accepted: true, clearInput: true,
    });
    expect(harness.reviewSteer).toHaveBeenCalledWith('review this edge case');
    expect(harness.workspace.steer).not.toHaveBeenCalled();
  });

  it('treats the Queue drain scheduling gap as active so normal Enter cannot jump the FIFO', async () => {
    const harness = createHarness(false, true);

    await harness.router.route('do not jump queue', 'enter');

    expect(harness.workspace.steer).toHaveBeenCalledWith('do not jump queue');
    expect(harness.workspace.submitPrompt).not.toHaveBeenCalled();
  });

  it('opens completion for bare slash without consuming or clearing it', async () => {
    const harness = createHarness();

    expect(await harness.router.route('/', 'enter')).toEqual({
      kind: 'completion',
      accepted: false,
      clearInput: false,
      input: '/',
      candidates: ['status'],
    });
    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('never falls back from unknown slash input to a Provider prompt', async () => {
    const harness = createHarness();

    const result = await harness.router.route('/sta', 'enter');

    expect(result).toMatchObject({ kind: 'error', accepted: false, clearInput: false, error: { code: 'unknown_command' } });
    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(harness.workspace.submitPrompt).not.toHaveBeenCalled();
  });

  it('preserves the original input when routing, persistence, or a Steer race fails', async () => {
    const harness = createHarness(true);
    harness.workspace.steer.mockResolvedValueOnce({ accepted: false, reason: 'run_ended' });

    const result = await harness.router.route('late guidance', 'enter');

    expect(result).toMatchObject({ kind: 'steer', accepted: false, clearInput: false, reason: 'run_ended' });
    expect(harness.workspace.queueAdd).not.toHaveBeenCalled();
  });

  it('uses Tab only for completion and Shift+Tab for reverse completion or mode toggle', async () => {
    const harness = createHarness();

    expect(await harness.router.route('/sta', 'tab')).toMatchObject({ kind: 'completion', input: '/status ' });
    expect(await harness.router.route('/sta', 'shift-tab')).toMatchObject({ kind: 'completion', input: '/status ' });
    expect(harness.complete).toHaveBeenNthCalledWith(1, '/sta', 'next');
    expect(harness.complete).toHaveBeenNthCalledWith(2, '/sta', 'previous');

    expect(await harness.router.route('draft', 'shift-tab')).toMatchObject({ kind: 'mode_toggle', accepted: true });
    expect(harness.toggleMode).toHaveBeenCalledOnce();
    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('rejects Shift+Tab mode changes while a run or Review is active', async () => {
    const harness = createHarness(true, false, true);

    await expect(harness.router.route('draft', 'shift-tab')).resolves.toEqual({
      kind: 'mode_toggle',
      accepted: false,
      clearInput: false,
      reason: 'run_active',
    });
    expect(harness.toggleMode).not.toHaveBeenCalled();
  });
});
