import { describe, it, expect } from 'vitest';

import { createSessionAllowlist } from '../../../../src/tools/permissions/sessionAllowlist.js';
import type { PermissionCheckInput, CompiledRule } from '../../../../src/tools/permissions/types.js';

function makeInput(toolName: string, args: Record<string, unknown>): PermissionCheckInput {
  return { toolName, toolRisk: 'write', parsedArguments: args, cwd: '/workspace' };
}

describe('createSessionAllowlist', () => {
  it('空列表时 has() 返回 false', () => {
    const allowlist = createSessionAllowlist();
    expect(allowlist.has(makeInput('run_command', { command: 'git push' }))).toBe(false);
  });

  it('添加规则后匹配成功', () => {
    const allowlist = createSessionAllowlist();
    const rule: CompiledRule = { toolName: 'run_command', argPattern: 'git *', action: 'allow' };
    allowlist.add(rule);
    expect(allowlist.has(makeInput('run_command', { command: 'git push' }))).toBe(true);
  });

  it('不匹配的工具名返回 false', () => {
    const allowlist = createSessionAllowlist();
    const rule: CompiledRule = { toolName: 'run_command', argPattern: 'git *', action: 'allow' };
    allowlist.add(rule);
    expect(allowlist.has(makeInput('write_file', { path: 'git/x.ts' }))).toBe(false);
  });

  it('无 pattern 规则匹配该工具的所有调用', () => {
    const allowlist = createSessionAllowlist();
    const rule: CompiledRule = { toolName: 'write_file', argPattern: undefined, action: 'allow' };
    allowlist.add(rule);
    expect(allowlist.has(makeInput('write_file', { path: 'anything.ts' }))).toBe(true);
  });

  it('新增规则优先级高于旧规则', () => {
    const allowlist = createSessionAllowlist();
    // 先添加 allow
    allowlist.add({ toolName: 'run_command', argPattern: 'git *', action: 'allow' });
    // 后添加 deny（更高优先级）
    allowlist.add({ toolName: 'run_command', argPattern: 'git *', action: 'deny' });
    // deny 优先，返回 false
    expect(allowlist.has(makeInput('run_command', { command: 'git push' }))).toBe(false);
  });

  it('clear() 清空所有规则', () => {
    const allowlist = createSessionAllowlist();
    allowlist.add({ toolName: 'run_command', argPattern: 'git *', action: 'allow' });
    allowlist.clear();
    expect(allowlist.has(makeInput('run_command', { command: 'git push' }))).toBe(false);
  });
});
