import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPermissionChecker } from '../../../../src/tools/permissions/checker.js';
import { loadPermissionRules } from '../../../../src/tools/permissions/config.js';
import { compileRules } from '../../../../src/tools/permissions/ruleEngine.js';
import { compileRule } from '../../../../src/tools/permissions/ruleParser.js';
import type {
  AskPermissionFn,
  PermissionCheckInput,
  PermissionRuleConfig,
} from '../../../../src/tools/permissions/types.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'perm-integration-'));
  mkdirSync(join(cwd, '.agentcode'), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeInput(
  toolName: string,
  args: Record<string, unknown>,
  risk: PermissionCheckInput['toolRisk'] = 'write',
): PermissionCheckInput {
  return { toolName, toolRisk: risk, parsedArguments: args, cwd };
}

const EMPTY_CONFIG: PermissionRuleConfig = { session: [], project: [], global: [] };

describe('权限系统集成测试', () => {
  // AC1: yolo 模式 + rm -rf / → permission_denied，黑名单优先级最高
  it('AC1: yolo 模式下黑名单仍拦截危险命令', async () => {
    const checker = createPermissionChecker({ mode: 'yolo', ruleConfig: EMPTY_CONFIG, cwd });
    const result = await checker.check(makeInput('run_command', { command: 'rm -rf /' }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.code).toBe('permission_denied');
      expect(result.error.message).toContain('blacklist');
      expect(result.source).toBe('blacklist');
    }
  });

  it('AC1: yolo 模式下 rm -r / 仍被黑名单拦截', async () => {
    const checker = createPermissionChecker({ mode: 'yolo', ruleConfig: EMPTY_CONFIG, cwd });
    const result = await checker.check(makeInput('run_command', { command: 'rm -r /' }, 'execute'));
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('blacklist');
  });

  // AC2: 路径越界输入通过完整管道拦截
  it('AC2: 路径越界通过完整 checker 管道拦截', async () => {
    const checker = createPermissionChecker({ mode: 'yolo', ruleConfig: EMPTY_CONFIG, cwd });
    const result = await checker.check(makeInput('read_file', { path: '../../etc/passwd' }, 'read'));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.code).toBe('permission_denied');
      expect(result.source).toBe('path_sandbox');
    }
  });

  // AC3: 配置 run_command(git *) allow → git status 放行不调用 askFn
  it('AC3: 规则 allow 命中时放行，不触发 askFn', async () => {
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

  // AC4: 三层优先级 — global allow + project deny → deny；再加 session allow → allow
  it('AC4: 三层规则优先级 — session > project > global', async () => {
    const config: PermissionRuleConfig = {
      session: [],
      project: compileRules([{ rule: 'run_command(npm *)', action: 'deny' }]),
      global: compileRules([{ rule: 'run_command(npm *)', action: 'allow' }]),
    };

    // project deny 优先于 global allow
    const checker1 = createPermissionChecker({ mode: 'yolo', ruleConfig: config, cwd });
    const result1 = await checker1.check(makeInput('run_command', { command: 'npm install' }));
    expect(result1.allowed).toBe(false);
    if (!result1.allowed) {
      expect(result1.source).toBe('rule_deny');
    }

    // 同一 checker 动态添加 session allow 后覆盖 project deny
    checker1.addSessionRule(compileRule({ rule: 'run_command(npm *)', action: 'allow' }));
    const result2 = await checker1.check(makeInput('run_command', { command: 'npm install' }));
    expect(result2.allowed).toBe(true);
    expect(result2.source).toBe('rule_allow');
  });

  // AC5: strict 模式无规则 → deny；yolo 模式无规则 → allow
  it('AC5: strict deny / yolo allow（无规则命中时的模式默认行为）', async () => {
    const strictChecker = createPermissionChecker({ mode: 'strict', ruleConfig: EMPTY_CONFIG, cwd });
    const strictResult = await strictChecker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(strictResult.allowed).toBe(false);
    if (!strictResult.allowed) {
      expect(strictResult.source).toBe('mode_default');
    }

    const yoloChecker = createPermissionChecker({ mode: 'yolo', ruleConfig: EMPTY_CONFIG, cwd });
    const yoloResult = await yoloChecker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(yoloResult.allowed).toBe(true);
    expect(yoloResult.source).toBe('mode_default');
  });

  // AC7: deny 后返回结构包含正确字段
  it('AC7: deny 返回结构包含 code=permission_denied + message', async () => {
    const checker = createPermissionChecker({ mode: 'strict', ruleConfig: EMPTY_CONFIG, cwd });
    const result = await checker.check(makeInput('write_file', { path: 'src/x.ts' }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toMatchObject({
        code: 'permission_denied',
        retryable: false,
      });
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  // AC8: 空 ruleConfig + normal 模式 → 正常触发 askFn（不崩溃）
  it('AC8: 空配置 + normal 模式正常运行不崩溃', async () => {
    const askFn = vi.fn<AskPermissionFn>().mockResolvedValue({ action: 'allow_once' });
    const checker = createPermissionChecker({ mode: 'normal', ruleConfig: EMPTY_CONFIG, cwd, askFn });
    const result = await checker.check(makeInput('run_command', { command: 'echo hello' }));
    expect(result.allowed).toBe(true);
    expect(askFn).toHaveBeenCalledOnce();
  });

  // AC8 补充: 损坏的 permissions.yaml 不影响启动
  it('AC8: 损坏的 YAML 文件不阻止规则加载', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(cwd, '.agentcode/permissions.yaml'), '{{broken yaml');
    const config = loadPermissionRules(cwd, tmpdir());
    expect(config.project).toHaveLength(0);
    expect(config.session).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // executor 集成: permissionChecker deny 时 executor 返回 permission_denied
  it('executor 集成: checker deny → executeToolCall 返回 permission_denied', async () => {
    const { executeToolCall } = await import('../../../../src/tools/executor.js');
    const mockChecker = {
      check: vi.fn().mockResolvedValue({
        allowed: false,
        error: { code: 'permission_denied' as const, message: 'Denied by test', retryable: false },
        source: 'blacklist' as const,
      }),
      addSessionRule: vi.fn(),
      getMode: vi.fn().mockReturnValue('normal' as const),
      setMode: vi.fn(),
    };

    const mockRegistry = {
      list: () => [],
      get: (name: string) =>
        name === 'test_tool'
          ? {
              name: 'test_tool',
              risk: 'write' as const,
              description: 'test',
              parameters: {},
              inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
              validate: (args: unknown) => ({ ok: true as const, value: args }),
              execute: vi.fn().mockResolvedValue({ ok: true, data: {}, meta: { durationMs: 0, timedOut: false } }),
            }
          : undefined,
      getProviderDeclarations: () => [],
      filterByRisk: () => mockRegistry,
    };

    const result = await executeToolCall(
      { name: 'test_tool', argumentsText: '{"x":1}', id: 'call-1' },
      mockRegistry,
      {
        cwd,
        timeoutMs: 5000,
        secrets: [],
        maxOutputBytes: 1024,
        permissionChecker: mockChecker,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied');
    }
  });
});
