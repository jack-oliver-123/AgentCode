import { describe, it, expect } from 'vitest';

import { checkAutoSafety } from '../../../../src/tools/permissions/autoSafety.js';
import type { PermissionCheckInput } from '../../../../src/tools/permissions/types.js';
import type { ToolRisk } from '../../../../src/tools/types.js';

function makeInput(toolName: string, args: Record<string, unknown>, risk: ToolRisk = 'write', cwd = '/workspace'): PermissionCheckInput {
  return { toolName, toolRisk: risk, parsedArguments: args, cwd };
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

  // 绝对路径白名单匹配
  it('auto + write_file 绝对路径在 src/ 内 → allow', () => {
    const result = checkAutoSafety(makeInput('write_file', { path: '/workspace/src/foo.ts' }, 'write', '/workspace'), 'auto');
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });

  it('auto + write_file 绝对路径在 tests/ 内 → allow', () => {
    const result = checkAutoSafety(makeInput('write_file', { path: '/workspace/tests/bar.test.ts' }, 'write', '/workspace'), 'auto');
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });

  // 路径穿越漏洞防护（Issue #49）
  it('auto + write_file 相邻目录名（/workspace/src → /workspacesrc 前缀匹配误判）→ undefined', () => {
    // /workspacesrc/evil.ts 不在 /workspace 内，不应被 src/** 匹配放行
    const result = checkAutoSafety(makeInput('write_file', { path: '/workspacesrc/evil.ts' }, 'write', '/workspace'), 'auto');
    expect(result).toBeUndefined();
  });

  it('auto + write_file 路径逃出 cwd（../outside/evil.ts）→ undefined', () => {
    const result = checkAutoSafety(makeInput('write_file', { path: '/workspace/../outside/evil.ts' }, 'write', '/workspace'), 'auto');
    expect(result).toBeUndefined();
  });

  it('auto + write_file cwd 外绝对路径（/etc/passwd）→ undefined', () => {
    const result = checkAutoSafety(makeInput('write_file', { path: '/etc/passwd' }, 'write', '/workspace'), 'auto');
    expect(result).toBeUndefined();
  });
});
