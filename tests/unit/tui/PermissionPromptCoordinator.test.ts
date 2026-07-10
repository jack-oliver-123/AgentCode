import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPermissionPromptCoordinator } from '../../../src/tui/permissionPromptCoordinator.js';
import type { PermissionCheckInput } from '../../../src/tools/permissions/types.js';

const INPUT: PermissionCheckInput = {
  toolName: 'run_command',
  toolRisk: 'execute',
  parsedArguments: { command: 'echo hello' },
  cwd: '/workspace',
};

describe('createPermissionPromptCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('响应活动请求后 resolve 并清空快照', async () => {
    const coordinator = createPermissionPromptCoordinator();
    const promise = coordinator.askPermission(INPUT, '[execute] run_command: echo hello');

    expect(coordinator.getSnapshot()).toMatchObject({
      toolName: 'run_command',
      description: '[execute] run_command: echo hello',
    });
    const requestId = coordinator.getSnapshot()!.id;

    coordinator.respond(requestId, { action: 'allow_session' });

    await expect(promise).resolves.toEqual({ action: 'allow_session' });
    expect(coordinator.getSnapshot()).toBeUndefined();
  });

  it('并发请求按 FIFO 串行展示', async () => {
    const coordinator = createPermissionPromptCoordinator();
    const first = coordinator.askPermission(INPUT, 'first');
    const second = coordinator.askPermission({ ...INPUT, toolName: 'write_file' }, 'second');

    expect(coordinator.getSnapshot()?.description).toBe('first');
    coordinator.respond(coordinator.getSnapshot()!.id, { action: 'allow_once' });
    await expect(first).resolves.toEqual({ action: 'allow_once' });

    expect(coordinator.getSnapshot()).toMatchObject({ toolName: 'write_file', description: 'second' });
    coordinator.respond(coordinator.getSnapshot()!.id, { action: 'deny' });
    await expect(second).resolves.toEqual({ action: 'deny' });
  });

  it('只有活动请求计时，超时后推进队列', async () => {
    const coordinator = createPermissionPromptCoordinator(100);
    const first = coordinator.askPermission(INPUT, 'first');
    const second = coordinator.askPermission({ ...INPUT, toolName: 'write_file' }, 'second');

    vi.advanceTimersByTime(100);
    await expect(first).resolves.toEqual({ action: 'deny' });
    expect(coordinator.getSnapshot()?.description).toBe('second');

    vi.advanceTimersByTime(99);
    expect(coordinator.getSnapshot()?.description).toBe('second');
    vi.advanceTimersByTime(1);
    await expect(second).resolves.toEqual({ action: 'deny' });
  });

  it('超时后重复响应不会二次结算', async () => {
    const coordinator = createPermissionPromptCoordinator(100);
    const promise = coordinator.askPermission(INPUT, 'first');
    const requestId = coordinator.getSnapshot()!.id;

    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toEqual({ action: 'deny' });
    coordinator.respond(requestId, { action: 'allow_once' });
    expect(coordinator.getSnapshot()).toBeUndefined();
  });

  it('旧 requestId 响应不会误结算下一条请求', async () => {
    const coordinator = createPermissionPromptCoordinator();
    const first = coordinator.askPermission(INPUT, 'first');
    const second = coordinator.askPermission({ ...INPUT, toolName: 'write_file' }, 'second');

    const firstId = coordinator.getSnapshot()!.id;

    // 结算第一条
    coordinator.respond(firstId, { action: 'allow_once' });
    await expect(first).resolves.toEqual({ action: 'allow_once' });

    // 第二条已激活
    const secondId = coordinator.getSnapshot()!.id;
    expect(secondId).not.toBe(firstId);

    // 用旧 id 重复响应，不应影响第二条
    coordinator.respond(firstId, { action: 'deny' });
    expect(coordinator.getSnapshot()?.toolName).toBe('write_file');

    // 用正确 id 响应第二条
    coordinator.respond(secondId, { action: 'allow_session' });
    await expect(second).resolves.toEqual({ action: 'allow_session' });
  });

  it('dispose 拒绝全部未完成请求', async () => {
    const coordinator = createPermissionPromptCoordinator();
    const first = coordinator.askPermission(INPUT, 'first');
    const second = coordinator.askPermission({ ...INPUT, toolName: 'write_file' }, 'second');

    coordinator.dispose();

    await expect(first).resolves.toEqual({ action: 'deny' });
    await expect(second).resolves.toEqual({ action: 'deny' });
    expect(coordinator.getSnapshot()).toBeUndefined();
    await expect(coordinator.askPermission(INPUT, 'after dispose')).resolves.toEqual({ action: 'deny' });
  });
});
