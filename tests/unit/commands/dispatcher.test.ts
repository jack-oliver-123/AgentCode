import { describe, expect, it, vi } from 'vitest';

import { AppRuntime } from '../../../src/app/runtime/AppRuntime.js';
import { CommandContextBuilder } from '../../../src/commands/context.js';
import { CommandDispatcher } from '../../../src/commands/dispatcher.js';
import { CommandError } from '../../../src/commands/errors.js';
import type {
  CommandAction,
  CommandDefinition,
  CommandMetadata,
  CommandOperation,
  ParsedCommandInput,
} from '../../../src/commands/types.js';

function metadata(): CommandMetadata {
  return {
    name: 'test',
    aliases: [],
    summary: 'test command',
    category: 'general',
    argumentMode: 'none',
    usage: ['/test'],
    examples: [{ invocation: '/test', description: 'test' }],
    execution: 'local',
    effects: ['ui'],
    activeRunPolicy: 'immediate',
    hidden: false,
    userInvocable: true,
    source: { type: 'builtin' },
  };
}

function definition(
  operation: CommandOperation,
  actions: readonly CommandAction[],
): CommandDefinition {
  return {
    metadata: metadata(),
    parseOperation: () => operation,
    handle: () => ({ kind: 'handled', actions }),
  };
}

function parsed(command: CommandDefinition): ParsedCommandInput<CommandDefinition> {
  return {
    raw: '/test',
    commandName: 'test',
    invokedAs: 'test',
    rawArguments: '',
    argv: [],
    command,
  };
}

function createHarness(options: {
  mode?: 'default' | 'plan';
  review?: boolean;
  active?: boolean;
  preflight?: (action: CommandAction) => Promise<void>;
  commit?: (action: CommandAction) => Promise<unknown>;
} = {}) {
  const runtime = new AppRuntime({
    mode: options.mode ?? 'default',
    session: {
      id: 'session-a',
      createdAt: 1,
      updatedAt: 1,
      turnCount: 0,
      resumed: false,
      agentMode: options.mode ?? 'default',
      selectedPermissionMode: 'normal',
      archivePath: 'session-a.jsonl',
    },
  });
  if (options.active === true || options.review === true) {
    runtime.dispatch({
      type: 'run.changed',
      run: {
        id: 'run-1',
        phase: 'streaming',
        reviewActive: options.review ?? false,
      },
    });
  }
  const contextBuilder = new CommandContextBuilder({
    getAppSnapshot: runtime.getSnapshot,
    getSessionSnapshot: () => runtime.getSnapshot().session!,
    getPermissionSnapshot: () => runtime.getSnapshot().permissions,
    getMemorySnapshot: async () => ({
      user: [],
      project: [],
      status: {
        autoNotesEnabled: false,
        counts: { user: 0, project: 0 },
        indexPaths: { user: '', project: '' },
        storagePaths: { user: '', project: '' },
      },
    }),
    getStatusSnapshot: async () => ({ local: true }),
  });
  const preflight = vi.fn(options.preflight ?? (async () => undefined));
  const commit = vi.fn(options.commit ?? (async () => undefined));
  return {
    runtime,
    preflight,
    commit,
    dispatcher: new CommandDispatcher({ contextBuilder, executor: { preflight, commit } }),
  };
}

const notice: CommandAction = {
  type: 'show_notice',
  idempotencyKey: 'notice-1',
  level: 'info',
  text: 'ok',
};

describe('CommandDispatcher', () => {
  it('performs every preflight before committing and commits nothing when any preflight fails', async () => {
    const second: CommandAction = {
      type: 'append_command_output',
      idempotencyKey: 'output-1',
      command: 'test',
      content: 'details',
    };
    const harness = createHarness({
      preflight: async (action) => {
        if (action === second) throw new Error('target missing');
      },
    });
    const command = definition(
      { kind: 'test.read', activeRunPolicy: 'immediate', readonlyPolicy: 'allow' },
      [notice, second],
    );

    const result = await harness.dispatcher.dispatch(parsed(command));

    expect(result).toMatchObject({ kind: 'rejected', consumed: false, error: { code: 'preflight_failed' } });
    expect(harness.preflight).toHaveBeenCalledTimes(2);
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['plan allow', 'plan', false, 'allow', true],
    ['plan control write', 'plan', false, 'control-write', true],
    ['plan data write', 'plan', false, 'reject', false],
    ['review allow', 'default', true, 'allow', true],
    ['review control write', 'default', true, 'control-write', true],
    ['review data write', 'default', true, 'reject', false],
  ] as const)('enforces the Plan/Review operation matrix: %s', async (_label, mode, review, readonlyPolicy, allowed) => {
    const harness = createHarness({ mode, review });
    const command = definition(
      { kind: 'test.operation', activeRunPolicy: 'immediate', readonlyPolicy },
      [notice],
    );

    const result = await harness.dispatcher.dispatch(parsed(command));

    expect(result.kind).toBe(allowed ? 'completed' : 'rejected');
    expect(harness.commit).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('reapplies the same operation-level active-run policy after confirmation', async () => {
    const harness = createHarness();
    const command = definition(
      { kind: 'session.resume', activeRunPolicy: 'reject', readonlyPolicy: 'reject' },
      [notice],
    );

    harness.runtime.dispatch({
      type: 'run.changed',
      run: { id: 'run-1', phase: 'streaming', reviewActive: false },
    });
    const result = await harness.dispatcher.dispatchOperation(command, {
      kind: 'session.resume',
      activeRunPolicy: 'reject',
      readonlyPolicy: 'reject',
    });

    expect(result).toMatchObject({ kind: 'rejected', consumed: false, error: { code: 'active_run_rejected' } });
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it('commits actions in order and stops accurately after a partial commit failure', async () => {
    const actions: CommandAction[] = [
      notice,
      { type: 'append_command_output', idempotencyKey: 'output-1', command: 'test', content: 'one' },
      { type: 'append_command_output', idempotencyKey: 'output-2', command: 'test', content: 'two' },
    ];
    const committed: string[] = [];
    const harness = createHarness({
      commit: async (action) => {
        committed.push(action.idempotencyKey);
        if (action.idempotencyKey === 'output-1') throw new Error('disk failed');
      },
    });
    const command = definition(
      { kind: 'test.multi', activeRunPolicy: 'immediate', readonlyPolicy: 'allow' },
      actions,
    );

    const result = await harness.dispatcher.dispatch(parsed(command));

    expect(committed).toEqual(['notice-1', 'output-1']);
    expect(result).toMatchObject({
      kind: 'failed',
      consumed: true,
      completed: ['notice-1'],
      pending: ['output-2'],
      error: { code: 'commit_failed' },
    });
  });

  it('deduplicates already committed action idempotency keys', async () => {
    const harness = createHarness();
    const command = definition(
      { kind: 'test.idempotent', activeRunPolicy: 'immediate', readonlyPolicy: 'allow' },
      [notice],
    );

    await harness.dispatcher.dispatch(parsed(command));
    await harness.dispatcher.dispatch(parsed(command));

    expect(harness.commit).toHaveBeenCalledOnce();
  });

  it('returns handler argument errors without invoking the executor', async () => {
    const harness = createHarness();
    const command: CommandDefinition = {
      metadata: metadata(),
      parseOperation: () => new CommandError('invalid_arguments', 'bad usage', { usage: ['/test'] }),
      handle: () => ({ kind: 'handled', actions: [notice] }),
    };

    expect(await harness.dispatcher.dispatch(parsed(command))).toMatchObject({
      kind: 'rejected',
      consumed: false,
      error: { code: 'invalid_arguments' },
    });
    expect(harness.preflight).not.toHaveBeenCalled();
  });
});
