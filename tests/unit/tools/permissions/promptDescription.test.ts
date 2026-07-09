import { describe, it, expect } from 'vitest';

import { buildPromptDescription } from '../../../../src/tools/permissions/promptDescription.js';
import type { PermissionCheckInput } from '../../../../src/tools/permissions/types.js';

describe('buildPromptDescription', () => {
  it('run_command → 输出包含 "run_command" 和命令内容', () => {
    const input: PermissionCheckInput = {
      toolName: 'run_command',
      toolRisk: 'write',
      parsedArguments: { command: 'npm install' },
      cwd: '/workspace',
    };
    const result = buildPromptDescription(input);
    expect(result).toContain('run_command');
    expect(result).toContain('npm install');
  });

  it('read_file → 输出包含 "read_file" 和路径', () => {
    const input: PermissionCheckInput = {
      toolName: 'read_file',
      toolRisk: 'read',
      parsedArguments: { path: 'src/index.ts' },
      cwd: '/workspace',
    };
    const result = buildPromptDescription(input);
    expect(result).toContain('read_file');
    expect(result).toContain('src/index.ts');
  });

  it('超长参数(>100字符) → 输出被截断并以 ... 结尾', () => {
    const longCmd = 'a'.repeat(150);
    const input: PermissionCheckInput = {
      toolName: 'run_command',
      toolRisk: 'write',
      parsedArguments: { command: longCmd },
      cwd: '/workspace',
    };
    const result = buildPromptDescription(input);
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longCmd.length + 50);
  });

  it('输出包含 risk 类型标识', () => {
    const input: PermissionCheckInput = {
      toolName: 'write_file',
      toolRisk: 'write',
      parsedArguments: { path: 'x.ts' },
      cwd: '/workspace',
    };
    const result = buildPromptDescription(input);
    expect(result).toContain('[write]');

    const readInput: PermissionCheckInput = {
      toolName: 'read_file',
      toolRisk: 'read',
      parsedArguments: { path: 'x.ts' },
      cwd: '/workspace',
    };
    const readResult = buildPromptDescription(readInput);
    expect(readResult).toContain('[read]');
  });
});
