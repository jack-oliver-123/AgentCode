import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkPathSandbox } from '../../../../src/tools/permissions/pathSandbox.js';
import type { PermissionCheckInput } from '../../../../src/tools/permissions/types.js';

let CWD: string;

beforeAll(() => {
  CWD = mkdtempSync(join(tmpdir(), 'perm-sandbox-test-'));
});

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
});

function makeInput(toolName: string, args: Record<string, unknown>): PermissionCheckInput {
  return {
    toolName,
    toolRisk: 'read',
    parsedArguments: args,
    cwd: CWD,
  };
}

describe('checkPathSandbox', () => {
  it('../../etc/passwd → deny (path_sandbox)', async () => {
    const result = await checkPathSandbox(makeInput('read_file', { path: '../../etc/passwd' }), CWD);
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(false);
    if (!result!.allowed) {
      expect(result!.source).toBe('path_sandbox');
    }
  });

  it('正常相对路径 src/index.ts → undefined', async () => {
    const result = await checkPathSandbox(makeInput('read_file', { path: 'src/index.ts' }), CWD);
    expect(result).toBeUndefined();
  });

  it('非文件类工具 run_command → undefined（跳过）', async () => {
    const result = await checkPathSandbox(
      makeInput('run_command', { command: 'cat /etc/passwd' }),
      CWD,
    );
    expect(result).toBeUndefined();
  });

  it('write_file 正确提取 path 字段', async () => {
    const result = await checkPathSandbox(
      makeInput('write_file', { path: '../../../etc/shadow' }),
      CWD,
    );
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(false);
  });

  it('edit_file 正确提取 path 字段', async () => {
    const result = await checkPathSandbox(
      makeInput('edit_file', { path: '../../root/.ssh/id_rsa' }),
      CWD,
    );
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(false);
  });

  it('glob_files 正确提取 pattern 字段', async () => {
    const result = await checkPathSandbox(
      makeInput('glob_files', { pattern: '../../**/*.ts' }),
      CWD,
    );
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(false);
  });

  it('search_code 正确提取 path 字段', async () => {
    const result = await checkPathSandbox(
      makeInput('search_code', { path: '../secret' }),
      CWD,
    );
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(false);
  });
});
