import { describe, it, expect } from 'vitest';

import { checkAutoSafety } from '../../../../src/tools/permissions/autoSafety.js';
import type { PermissionCheckInput } from '../../../../src/tools/permissions/types.js';
import type { ToolRisk } from '../../../../src/tools/types.js';

function makeInput(toolName: string, args: Record<string, unknown>, risk: ToolRisk = 'write'): PermissionCheckInput {
  return { toolName, toolRisk: risk, parsedArguments: args, cwd: '/workspace' };
}

describe('checkAutoSafety', () => {
  it('mode !== auto → undefined（跳过）', () => {
    const result = checkAutoSafety(makeInput('read_file', { path: 'x.ts' }, 'read'), 'normal');
    expect(result).toBeUndefined();
  });

  it('auto + read_file → allow (auto_safety)', () => {
    const result = checkAutoSafety(makeInput('read_file', { path: 'anything' }, 'read'), 'auto');
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
    expect(result!.source).toBe('auto_safety');
  });

  it('auto + write_file 路径 src/foo.ts → allow', () => {
    const result = checkAutoSafety(makeInput('write_file', { path: 'src/foo.ts' }), 'auto');
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });

  it('auto + write_file 路径 node_modules/x.js → undefined（不在白名单）', () => {
    const result = checkAutoSafety(makeInput('write_file', { path: 'node_modules/x.js' }), 'auto');
    expect(result).toBeUndefined();
  });

  it('auto + run_command git status → allow', () => {
    const result = checkAutoSafety(makeInput('run_command', { command: 'git status' }), 'auto');
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });

  it('auto + run_command curl http://example.com → undefined（不在白名单）', () => {
    const result = checkAutoSafety(makeInput('run_command', { command: 'curl http://example.com' }), 'auto');
    expect(result).toBeUndefined();
  });

  it('auto + run_command npm test → allow', () => {
    const result = checkAutoSafety(makeInput('run_command', { command: 'npm test' }), 'auto');
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });

  it('前缀匹配: git log --oneline 匹配 git log 前缀 → allow', () => {
    const result = checkAutoSafety(makeInput('run_command', { command: 'git log --oneline' }), 'auto');
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });
});
