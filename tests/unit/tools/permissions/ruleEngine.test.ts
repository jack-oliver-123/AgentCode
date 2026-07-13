import { describe, it, expect } from 'vitest';

import { compileRules, matchRules } from '../../../../src/tools/permissions/ruleEngine.js';
import { parseRulePattern, compileRule } from '../../../../src/tools/permissions/ruleParser.js';
import type { PermissionCheckInput, PermissionRuleConfig } from '../../../../src/tools/permissions/types.js';

describe('parseRulePattern', () => {
  it('run_command(git *) → { toolName, argPattern }', () => {
    const result = parseRulePattern('run_command(git *)');
    expect(result.toolName).toBe('run_command');
    expect(result.argPattern).toBe('git *');
  });

  it('read_file（无括号）→ { toolName, argPattern: undefined }', () => {
    const result = parseRulePattern('read_file');
    expect(result.toolName).toBe('read_file');
    expect(result.argPattern).toBeUndefined();
  });
});

describe('matchRules', () => {
  function makeInput(toolName: string, args: Record<string, unknown>): PermissionCheckInput {
    return { toolName, toolRisk: 'write', parsedArguments: args, cwd: '/workspace' };
  }

  function makeConfig(
    session: { rule: string; action: 'allow' | 'deny' }[] = [],
    project: { rule: string; action: 'allow' | 'deny' }[] = [],
    global: { rule: string; action: 'allow' | 'deny' }[] = [],
  ): PermissionRuleConfig {
    return {
      session: compileRules(session),
      project: compileRules(project),
      global: compileRules(global),
    };
  }

  it('glob * 匹配: git * 匹配 git status', () => {
    const config = makeConfig([], [{ rule: 'run_command(git *)', action: 'allow' }]);
    const result = matchRules(makeInput('run_command', { command: 'git status' }), config);
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });

  it('glob * 不匹配: git * 不匹配 npm test', () => {
    const config = makeConfig([], [{ rule: 'run_command(git *)', action: 'allow' }]);
    const result = matchRules(makeInput('run_command', { command: 'npm test' }), config);
    expect(result).toBeUndefined();
  });

  it('glob ** 匹配: src/** 匹配 src/a/b/c.ts', () => {
    const config = makeConfig([], [{ rule: 'write_file(src/**)', action: 'allow' }]);
    const result = matchRules(makeInput('write_file', { path: 'src/a/b/c.ts' }), config);
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
  });

  it('glob ? 匹配: ?.ts 匹配 a.ts', () => {
    const config = makeConfig([], [{ rule: 'write_file(?.ts)', action: 'allow' }]);
    const result = matchRules(makeInput('write_file', { path: 'a.ts' }), config);
    expect(result!.allowed).toBe(true);
  });

  it('glob ? 不匹配: ?.ts 不匹配 ab.ts', () => {
    const config = makeConfig([], [{ rule: 'write_file(?.ts)', action: 'allow' }]);
    const result = matchRules(makeInput('write_file', { path: 'ab.ts' }), config);
    expect(result).toBeUndefined();
  });

  it('三层优先级: session allow + project deny → allow', () => {
    const config = makeConfig(
      [{ rule: 'run_command(git *)', action: 'allow' }],
      [{ rule: 'run_command(git *)', action: 'deny' }],
    );
    const result = matchRules(makeInput('run_command', { command: 'git push' }), config);
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(true);
    expect(result!.source).toBe('rule_allow');
  });

  it('同层 first-match: 先 deny 后 allow → deny', () => {
    const config = makeConfig([], [
      { rule: 'run_command(git *)', action: 'deny' },
      { rule: 'run_command(git *)', action: 'allow' },
    ]);
    const result = matchRules(makeInput('run_command', { command: 'git push' }), config);
    expect(result).not.toBeUndefined();
    expect(result!.allowed).toBe(false);
    expect(result!.source).toBe('rule_deny');
  });

  it('全未命中 → undefined', () => {
    const config = makeConfig([], [{ rule: 'run_command(git *)', action: 'deny' }]);
    const result = matchRules(makeInput('write_file', { path: 'src/a.ts' }), config);
    expect(result).toBeUndefined();
  });

  it('参数提取: glob_files → pattern', () => {
    const config = makeConfig([], [{ rule: 'glob_files(src/**)', action: 'allow' }]);
    const result = matchRules(makeInput('glob_files', { pattern: 'src/utils/x.ts' }), config);
    expect(result!.allowed).toBe(true);
  });

  it('参数提取: search_code → path', () => {
    const config = makeConfig([], [{ rule: 'search_code(src/**)', action: 'allow' }]);
    const result = matchRules(makeInput('search_code', { path: 'src/tools/index.ts' }), config);
    expect(result!.allowed).toBe(true);
  });
});
