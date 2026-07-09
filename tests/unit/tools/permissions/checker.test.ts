import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPermissionChecker } from '../../../../src/tools/permissions/checker.js';
import type {
  AskPermissionFn,
  PermissionCheckInput,
  PermissionRuleConfig,
  PromptResponse,
} from '../../../../src/tools/permissions/types.js';
import { compileRules } from '../../../../src/tools/permissions/ruleEngine.js';

// 使用真实的 cwd 以满足 pathSandbox 的 realpath 要求
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'perm-checker-'));
  // 创建 .agentcode 目录供 appendProjectRule 使用
  mkdirSync(join(cwd, '.agentcode'), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeInput(toolName: string, args: Record<string, unknown>, risk: 'read' | 'write' = 'write'): PermissionCheckInput {
  return { toolName, toolRisk: risk, parsedArguments: args, cwd };
}

const EMPTY_CONFIG: PermissionRuleConfig = { session: [], project: [], global: [] };

describe('createPermissionChecker', () => {
  it('黑名单命中 → deny（即使 mode=yolo）', async () => {
    const checker = createPermissionChecker({ mode: 'yolo', ruleConfig: EMPTY_CONFIG, cwd });
    const result = await checker.check(makeInput('run_command', { command: 'rm -rf /' }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe('blacklist');
    }
  });

  it('路径越界 → deny', async () => {
    const checker = createPermissionChecker({ mode: 'yolo', ruleConfig: EMPTY_CONFIG, cwd });
    const result = await checker.check(makeInput('read_file', { path: '../../etc/passwd' }, 'read'));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe('path_sandbox');
    }
  });

  it('规则 allow 命中 → allow（不调用 askFn）', async () => {
    const askFn = vi.fn<AskPermissionFn>();
    const config: PermissionRuleConfig = {
      session: [],
      project: compileRules([{ rule: 'run_command(git *)', action: 'allow' }]),
      global: [],
    };
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: config, cwd, askFn });
    const result = await checker.check(makeInput('run_command', { command: 'git status' }));
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('rule_allow');
    expect(askFn).not.toHaveBeenCalled();
  });

  it('规则 deny 命中 → deny（不调用 askFn）', async () => {
    const askFn = vi.fn<AskPermissionFn>();
    const config: PermissionRuleConfig = {
      session: [],
      project: compileRules([{ rule: 'run_command(rm *)', action: 'deny' }]),
      global: [],
    };
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: config, cwd, askFn });
    const result = await checker.check(makeInput('run_command', { command: 'rm file.txt' }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe('rule_deny');
    }
    expect(askFn).not.toHaveBeenCalled();
  });

  it('auto 模式 + read_file → allow（不调用 askFn）', async () => {
    const askFn = vi.fn<AskPermissionFn>();
    const checker = createPermissionChecker({ mode: 'auto', ruleConfig: EMPTY_CONFIG, cwd, askFn });
    const result = await checker.check(makeInput('read_file', { path: 'src/x.ts' }, 'read'));
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('auto_safety');
    expect(askFn).not.toHaveBeenCalled();
  });

  it('normal 模式 + 无规则命中 → 调用 askFn', async () => {
    const askFn = vi.fn<AskPermissionFn>().mockResolvedValue({ action: 'allow_once' });
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd, askFn });
    await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(askFn).toHaveBeenCalledOnce();
  });

  it('askFn 返回 allow_once → allowed，再次调用仍触发 askFn', async () => {
    const askFn = vi.fn<AskPermissionFn>().mockResolvedValue({ action: 'allow_once' });
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd, askFn });

    const r1 = await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(r1.allowed).toBe(true);

    await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(askFn).toHaveBeenCalledTimes(2);
  });

  it('askFn 返回 allow_session → allowed，再次调用不触发 askFn', async () => {
    const askFn = vi.fn<AskPermissionFn>().mockResolvedValue({ action: 'allow_session' });
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd, askFn });

    const r1 = await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(r1.allowed).toBe(true);

    const r2 = await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(r2.allowed).toBe(true);
    expect(r2.source).toBe('session_grant');
    // askFn 只被调用了一次
    expect(askFn).toHaveBeenCalledOnce();
  });

  it('askFn 返回 allow_permanent → allowed + 写入项目规则文件', async () => {
    const askFn = vi.fn<AskPermissionFn>().mockResolvedValue({ action: 'allow_permanent' });
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd, askFn });

    const result = await checker.check(makeInput('run_command', { command: 'npm test' }));
    expect(result.allowed).toBe(true);

    // 验证文件已创建
    const { loadPermissionRules } = await import('../../../../src/tools/permissions/config.js');
    const config = loadPermissionRules(cwd, tmpdir());
    expect(config.project.length).toBeGreaterThan(0);
  });

  it('askFn 返回 deny → denied', async () => {
    const askFn = vi.fn<AskPermissionFn>().mockResolvedValue({ action: 'deny' });
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd, askFn });

    const result = await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe('user_prompt');
    }
  });

  it('无 askFn + needs_prompt → deny（fail-safe）', async () => {
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd });
    const result = await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(result.allowed).toBe(false);
  });

  it('askFn 抛异常 → deny', async () => {
    const askFn = vi.fn<AskPermissionFn>().mockRejectedValue(new Error('timeout'));
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd, askFn });

    const result = await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe('user_prompt');
    }
  });

  it('appendProjectRule 失败 → 降级为 session grant + console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 创建一个文件来阻止 mkdirSync 创建 .agentcode 目录
    const fakeCwd = mkdtempSync(join(tmpdir(), 'perm-checker-bad-'));
    writeFileSync(join(fakeCwd, '.agentcode'), 'blocking file');

    const askFn = vi.fn<AskPermissionFn>().mockResolvedValue({ action: 'allow_permanent' });
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd: fakeCwd, askFn });

    const result = await checker.check({
      toolName: 'run_command',
      toolRisk: 'write',
      parsedArguments: { command: 'echo test' },
      cwd: fakeCwd,
    });
    // 即使写入失败，仍然应该 allow（降级为 session grant）
    expect(result.allowed).toBe(true);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    rmSync(fakeCwd, { recursive: true, force: true });
  });
});
