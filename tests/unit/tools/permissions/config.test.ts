import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadPermissionRules, appendProjectRule } from '../../../../src/tools/permissions/config.js';

describe('loadPermissionRules', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'perm-config-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'perm-config-home-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('正常 YAML 文件加载：两条规则正确编译', () => {
    const dir = join(cwd, '.agentcode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'permissions.yaml'), `rules:
  - rule: "run_command(git *)"
    action: allow
  - rule: "write_file(src/**)"
    action: deny
`);

    const config = loadPermissionRules(cwd, home);
    expect(config.project).toHaveLength(2);
    expect(config.project[0]!.toolName).toBe('run_command');
    expect(config.project[0]!.argPattern).toBe('git *');
    expect(config.project[0]!.action).toBe('allow');
    expect(config.project[1]!.toolName).toBe('write_file');
    expect(config.project[1]!.action).toBe('deny');
  });

  it('项目级文件不存在 → 该层返回空数组', () => {
    const config = loadPermissionRules(cwd, home);
    expect(config.project).toHaveLength(0);
  });

  it('全局级文件不存在 → 该层返回空数组', () => {
    const config = loadPermissionRules(cwd, home);
    expect(config.global).toHaveLength(0);
  });

  it('YAML 格式错误 → console.warn 被调用，返回空数组', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = join(cwd, '.agentcode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'permissions.yaml'), '{{{{invalid yaml');

    const config = loadPermissionRules(cwd, home);
    expect(config.project).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('返回的 session 始终为空数组', () => {
    const config = loadPermissionRules(cwd, home);
    expect(config.session).toHaveLength(0);
  });
});

describe('appendProjectRule', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'perm-append-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('文件不存在时：创建文件并写入规则', () => {
    appendProjectRule(cwd, 'run_command(git push)');
    const content = readFileSync(join(cwd, '.agentcode/permissions.yaml'), 'utf-8');
    expect(content).toContain('run_command(git push)');
    expect(content).toContain('allow');
  });

  it('文件已有内容时：追加新规则不破坏已有规则', () => {
    const dir = join(cwd, '.agentcode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'permissions.yaml'), `rules:
  - rule: "read_file"
    action: allow
`);

    appendProjectRule(cwd, 'run_command(npm test)');
    const config = loadPermissionRules(cwd, tmpdir());
    expect(config.project).toHaveLength(2);
    expect(config.project[0]!.toolName).toBe('read_file');
    expect(config.project[1]!.toolName).toBe('run_command');
    expect(config.project[1]!.argPattern).toBe('npm test');
  });

  it('写入后的 YAML 可被 loadPermissionRules 正确解析', () => {
    appendProjectRule(cwd, 'write_file(src/**)');
    const config = loadPermissionRules(cwd, tmpdir());
    expect(config.project).toHaveLength(1);
    expect(config.project[0]!.toolName).toBe('write_file');
    expect(config.project[0]!.argPattern).toBe('src/**');
  });

  it('写入失败时抛出异常', () => {
    // 用一个文件阻止 .agentcode 目录创建
    writeFileSync(join(cwd, '.agentcode'), 'blocking file');
    expect(() => appendProjectRule(cwd, 'run_command(echo hi)')).toThrow();
  });
});
