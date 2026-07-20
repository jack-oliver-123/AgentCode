import { describe, expect, it, vi } from 'vitest';

import {
  PermissionManager,
  PermissionTargetChangedError,
  type PermissionRuleStorage,
} from '../../../src/app/permissions/PermissionManager.js';

function memoryStorage(initial: { project?: string; global?: string } = {}): PermissionRuleStorage & {
  contents: { project?: string; global?: string };
} {
  const contents = { ...initial };
  return {
    contents,
    read: async (scope) => contents[scope],
    write: async (scope, content) => {
      contents[scope] = content;
    },
  };
}

describe('PermissionManager', () => {
  it('separates selected mode from the Plan/Review readonly cap', async () => {
    const manager = await PermissionManager.open({
      selectedMode: 'normal',
      agentMode: 'plan',
      storage: memoryStorage(),
    });

    expect(manager.snapshot()).toMatchObject({ selectedMode: 'normal', effectiveMode: 'readonly' });
    expect(await manager.setSelectedMode('yolo')).toMatchObject({ kind: 'confirmation_required' });
    expect(await manager.setSelectedMode('yolo', { confirmed: true })).toMatchObject({ kind: 'applied' });
    expect(manager.snapshot()).toMatchObject({ selectedMode: 'yolo', effectiveMode: 'readonly' });

    await manager.setModeCap({ agentMode: 'default', reviewActive: true });
    expect(manager.snapshot().effectiveMode).toBe('readonly');
    await manager.setModeCap({ agentMode: 'default', reviewActive: false });
    expect(manager.snapshot()).toMatchObject({ selectedMode: 'yolo', effectiveMode: 'yolo' });
  });

  it('requires confirmation for widening, applies tightening immediately, and emits generation audits', async () => {
    const audits: unknown[] = [];
    const manager = await PermissionManager.open({
      selectedMode: 'normal',
      agentMode: 'default',
      storage: memoryStorage(),
      now: () => 100,
      onAudit: (event) => {
        audits.push(event);
      },
    });

    expect(await manager.setSelectedMode('auto', { activeRunId: 'run-1' })).toEqual({
      kind: 'confirmation_required',
      from: 'normal',
      to: 'auto',
    });
    expect(manager.snapshot().generation).toBe(0);

    await manager.setSelectedMode('auto', { confirmed: true, activeRunId: 'run-1' });
    await manager.setSelectedMode('strict', { activeRunId: 'run-1' });

    expect(manager.snapshot()).toMatchObject({ selectedMode: 'strict', effectiveMode: 'strict', generation: 2 });
    expect(audits).toEqual([
      expect.objectContaining({ operation: 'permission.mode', generation: 1, oldSelectedMode: 'normal', newSelectedMode: 'auto' }),
      expect.objectContaining({ operation: 'permission.mode', generation: 2, oldSelectedMode: 'auto', newSelectedMode: 'strict' }),
    ]);
  });

  it('uses the latest generation and effective mode for every not-yet-started tool preflight', async () => {
    const manager = await PermissionManager.open({
      selectedMode: 'normal',
      agentMode: 'default',
      storage: memoryStorage(),
    });
    const input = {
      toolName: 'write_file',
      toolRisk: 'write' as const,
      parsedArguments: { path: 'x' },
      cwd: process.cwd(),
    };

    const before = await manager.preflight(input);
    expect(before.generation).toBe(0);
    expect(before.decision.allowed).toBe(false);

    await manager.setSelectedMode('yolo', { confirmed: true });
    const after = await manager.preflight(input);
    expect(after.generation).toBe(1);
    expect(after.decision.allowed).toBe(true);

    await manager.setModeCap({ agentMode: 'plan', reviewActive: false });
    const capped = await manager.preflight(input);
    expect(capped.generation).toBe(2);
    expect(capped.decision.allowed).toBe(false);
  });

  it.each([
    ['allow_session', 'session'],
    ['allow_permanent', 'project'],
  ] as const)('promotes %s tool approval into the authoritative %s rules', async (action, scope) => {
    const storage = memoryStorage();
    const askPermission = vi.fn(async () => ({ action }));
    const audits: unknown[] = [];
    const manager = await PermissionManager.open({
      selectedMode: 'normal',
      agentMode: 'default',
      storage,
      askPermission,
      onAudit: (event) => {
        audits.push(event);
      },
    });
    const input = {
      toolName: 'write_file',
      toolRisk: 'write' as const,
      parsedArguments: { path: 'src/new.ts' },
      cwd: process.cwd(),
    };

    const [first, second] = await Promise.all([
      manager.preflight(input, { activeRunId: 'run-1' }),
      manager.preflight(input, { activeRunId: 'run-2' }),
    ]);

    expect(first).toMatchObject({ generation: 1, decision: { allowed: true } });
    expect(second).toMatchObject({ generation: 1, decision: { allowed: true, source: 'rule_allow' } });
    expect(manager.snapshot().counts[scope]).toBe(1);
    expect(askPermission).toHaveBeenCalledOnce();
    expect(audits).toContainEqual(expect.objectContaining({
      operation: scope === 'session' ? 'permission.session_rule' : 'permission.project_rule',
      activeRunId: 'run-1',
    }));
    if (scope === 'project') expect(storage.contents.project).toContain('write_file');
  });

  it('lists stable rule views and atomically removes a rule', async () => {
    const storage = memoryStorage({
      project: 'rules:\n  - rule: read_file(src/**)\n    action: allow\n  - rule: run_command(rm *)\n    action: deny\n',
    });
    const manager = await PermissionManager.open({
      selectedMode: 'normal',
      agentMode: 'default',
      storage,
    });
    const views = await manager.getRuleViews('project');
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ scope: 'project', rule: 'read_file(src/**)', action: 'allow' });

    await manager.removeRule('project', views[0]!.id, { expectedGeneration: 0 });

    expect(manager.snapshot()).toMatchObject({ generation: 1, counts: { project: 1 } });
    expect((await manager.getRuleViews('project')).map((rule) => rule.rule)).toEqual(['run_command(rm *)']);
    expect(storage.contents.project).not.toContain('read_file');
  });

  it('keeps the old authoritative rules when atomic persistence fails', async () => {
    const write = vi.fn(async () => {
      throw new Error('read-only filesystem');
    });
    const storage: PermissionRuleStorage = {
      read: async (scope) =>
        scope === 'project' ? 'rules:\n  - rule: read_file(src/**)\n    action: allow\n' : undefined,
      write,
    };
    const manager = await PermissionManager.open({
      selectedMode: 'normal',
      agentMode: 'default',
      storage,
    });
    const rule = (await manager.getRuleViews('project'))[0]!;

    await expect(manager.removeRule('project', rule.id, { expectedGeneration: 0 })).rejects.toThrow('read-only filesystem');

    expect(write).toHaveBeenCalledOnce();
    expect(manager.snapshot()).toMatchObject({ generation: 0, counts: { project: 1 } });
    expect(await manager.getRuleViews('project')).toEqual([rule]);
  });

  it('rejects a stale confirmation generation without writing', async () => {
    const storage = memoryStorage({
      project: 'rules:\n  - rule: read_file(src/**)\n    action: allow\n',
    });
    const manager = await PermissionManager.open({
      selectedMode: 'normal',
      agentMode: 'default',
      storage,
    });
    const rule = (await manager.getRuleViews('project'))[0]!;
    await manager.setSelectedMode('strict');

    await expect(manager.removeRule('project', rule.id, { expectedGeneration: 0 })).rejects.toBeInstanceOf(
      PermissionTargetChangedError,
    );
    expect(await manager.getRuleViews('project')).toHaveLength(1);
  });
});
