import { describe, expect, it } from 'vitest';

import { AppRuntime } from '../../../src/app/runtime/AppRuntime.js';
import {
  StatusService,
  type StatusServiceOptions,
} from '../../../src/app/status/StatusService.js';

function createOptions(runtime: AppRuntime, overrides: Partial<StatusServiceOptions> = {}): StatusServiceOptions {
  return {
    getAppSnapshot: runtime.getSnapshot,
    cwd: 'C:\\repo',
    provider: {
      protocol: 'openai',
      model: 'gpt-test',
      thinkingEnabled: true,
    },
    getContextStatus: () => ({
      estimatedTokens: 25,
      contextWindow: 100,
      compaction: 'idle',
    }),
    getMemoryStatus: async () => ({
      autoNotesEnabled: true,
      counts: { user: 2, project: 3 },
      indexPaths: { user: 'user/MEMORY.md', project: 'project/MEMORY.md' },
      storagePaths: { user: 'user', project: 'project' },
    }),
    probeGit: async () => ({ branch: 'main', dirty: true }),
    probeMcp: async () => ({ configured: 2, connected: 1, failed: 1 }),
    config: { source: 'project', path: 'C:\\repo\\.agentcode\\config.yaml' },
    ...overrides,
  };
}

describe('StatusService', () => {
  it('builds a concise status bar for mode, run, estimated tokens, and Queue state', () => {
    const runtime = new AppRuntime({ mode: 'default' });
    runtime.dispatch({
      type: 'queue.changed',
      queue: { count: 2, paused: true, draining: false, version: 3 },
    });
    runtime.dispatch({
      type: 'run.changed',
      run: { id: 'run-1', phase: 'streaming', reviewActive: true },
    });
    const service = new StatusService(createOptions(runtime));

    expect(service.getStatusBar()).toEqual({
      mode: 'review',
      runStatus: 'streaming',
      model: 'gpt-test',
      estimatedTokens: 25,
      queueCount: 2,
      queuePaused: true,
      contextPercent: 25,
    });
  });

  it('returns all detailed local sections without making a Provider request', async () => {
    const runtime = new AppRuntime({
      mode: 'plan',
      session: {
        id: 'session-a',
        name: 'work',
        createdAt: 1,
        updatedAt: 2,
        turnCount: 4,
        resumed: true,
        agentMode: 'plan',
        selectedPermissionMode: 'yolo',
        archivePath: 'session-a.jsonl',
      },
      permissions: {
        selectedMode: 'yolo',
        effectiveMode: 'readonly',
        generation: 5,
        counts: { session: 1, project: 2, global: 3 },
      },
    });
    const service = new StatusService(createOptions(runtime));

    const status = await service.getDetailedStatus();

    expect(status).toMatchObject({
      runtime: { mode: 'plan', cwd: 'C:\\repo' },
      provider: { protocol: 'openai', model: 'gpt-test', thinkingEnabled: true },
      context: { estimatedTokens: 25, contextWindow: 100, percent: 25, compaction: 'idle' },
      session: { id: 'session-a', name: 'work', turnCount: 4, resumed: true },
      permission: { selectedMode: 'yolo', effectiveMode: 'readonly', generation: 5 },
      memory: { counts: { user: 2, project: 3 } },
      git: { status: 'available', branch: 'main', dirty: true },
      mcp: { status: 'available', configured: 2, connected: 1, failed: 1 },
      config: { source: 'project' },
    });
  });

  it('bounds slow Git/MCP probes independently and marks only timed-out sections unknown', async () => {
    const runtime = new AppRuntime({ mode: 'default' });
    const never = new Promise<never>(() => undefined);
    const service = new StatusService(
      createOptions(runtime, {
        probeGit: async () => never,
        probeMcp: async () => never,
        probeTimeoutMs: 10,
      }),
    );

    const status = await service.getDetailedStatus();

    expect(status.git).toEqual({ status: 'unknown' });
    expect(status.mcp).toEqual({ status: 'unknown' });
    expect(status.memory).toMatchObject({ counts: { user: 2, project: 3 } });
    expect(status.provider.model).toBe('gpt-test');
  });

  it('shows recent command and Agent errors through independent channels', async () => {
    const runtime = new AppRuntime({ mode: 'default' });
    runtime.dispatch({
      type: 'command.error',
      error: { code: 'invalid_arguments', message: 'bad command', at: 10 },
    });
    runtime.dispatch({
      type: 'agent.error',
      error: { code: 'provider_error', message: 'provider failed', retryable: true },
    });
    const service = new StatusService(createOptions(runtime));

    expect((await service.getDetailedStatus()).errors).toEqual({
      command: { code: 'invalid_arguments', message: 'bad command', at: 10 },
      agent: { code: 'provider_error', message: 'provider failed', retryable: true },
    });
  });
});
