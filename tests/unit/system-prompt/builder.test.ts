import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from '../../../src/system-prompt/builder.js';
import { defaultRegistry } from '../../../src/system-prompt/registry.js';
import type { SystemPromptBuildInput, SystemPromptModule } from '../../../src/system-prompt/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function baseInput(overrides: Partial<SystemPromptBuildInput> = {}): SystemPromptBuildInput {
  return { mode: 'full', turnIndex: 0, ...overrides };
}

// ─── AC1: 固定模块按 order 升序拼装 + disabled ────────────────────────────

describe('buildSystemPrompt - 模块拼装顺序与 disabled', () => {
  it('AC1: 8 个有内容的固定模块按 order 升序拼装', () => {
    const result = buildSystemPrompt(baseInput());
    // defaultRegistry 中 custom-instructions 和 memory 的 content 为空，不参与拼装
    const enabledModules = defaultRegistry.filter((m) => m.content.length > 0).sort((a, b) => a.order - b.order);

    // 每个启用模块的 content 都出现在 system 中
    for (const mod of enabledModules) {
      expect(result.system).toContain(mod.content);
    }

    // 顺序正确：每个模块的位置严格递增
    let lastIndex = -1;
    for (const mod of enabledModules) {
      const idx = result.system.indexOf(mod.content);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('AC1: disabled identity 时输出不含 identity 内容', () => {
    const result = buildSystemPrompt(baseInput({ disabled: ['identity'] }));
    const identityModule = defaultRegistry.find((m) => m.id === 'identity')!;
    expect(result.system).not.toContain(identityModule.content);
  });
});

// ─── AC1a: 相邻模块间恰好以 \n\n 分隔 ────────────────────────────────────

describe('buildSystemPrompt - 模块分隔符', () => {
  it('AC1a: split by \\n\\n 后长度 = 启用模块数', () => {
    const result = buildSystemPrompt(baseInput());
    const enabledCount = defaultRegistry.filter((m) => m.content.length > 0).length;
    const segments = result.system.split('\n\n');
    // 注意：某些模块 content 内部也可能包含 \n\n，所以用自定义 registry 更精确
    // 这里用自定义 registry 验证
    const customRegistry: SystemPromptModule[] = [
      { id: 'a', order: 100, content: 'AAA' },
      { id: 'b', order: 200, content: 'BBB' },
      { id: 'c', order: 300, content: 'CCC' },
    ];
    const customResult = buildSystemPrompt(baseInput(), customRegistry);
    expect(customResult.system).toBe('AAA\n\nBBB\n\nCCC');
    expect(customResult.system.split('\n\n').length).toBe(3);
  });
});

// ─── AC1b: disabled 含不存在 ID 不报错 ────────────────────────────────────

describe('buildSystemPrompt - disabled 容错', () => {
  it('AC1b: disabled 含不存在 ID 不报错，输出与不传 disabled 一致', () => {
    const resultNone = buildSystemPrompt(baseInput());
    const resultBogus = buildSystemPrompt(baseInput({ disabled: ['nonexistent'] }));
    expect(resultBogus.system).toBe(resultNone.system);
  });
});

// ─── AC7: 自定义 registry 注入可选模块 ────────────────────────────────────

describe('buildSystemPrompt - 自定义模块注入', () => {
  it('AC7: push order=800 的自定义模块后，输出末尾包含其内容', () => {
    const customRegistry: SystemPromptModule[] = [
      { id: 'base', order: 100, content: 'base content' },
      { id: 'test-custom', order: 800, content: 'test content' },
    ];
    const result = buildSystemPrompt(baseInput(), customRegistry);
    expect(result.system).toContain('test content');
    expect(result.system.endsWith('test content')).toBe(true);
  });

  it('AC7a: 空 content 条目不参与拼装，无尾部空行', () => {
    const customRegistry: SystemPromptModule[] = [
      { id: 'a', order: 100, content: 'first' },
      { id: 'b', order: 200, content: '' },
      { id: 'c', order: 300, content: 'last' },
    ];
    const result = buildSystemPrompt(baseInput(), customRegistry);
    expect(result.system).toBe('first\n\nlast');
    // 不含尾部空行
    expect(result.system.endsWith('\n')).toBe(false);
  });
});

// ─── AC6: plan mode reminder 完整版 / 精简版 ──────────────────────────────

describe('buildSystemPrompt - plan mode reminder', () => {
  it('AC6: plan mode turnIndex=0 返回完整版（包含"当前模式"和"plan"）', () => {
    const result = buildSystemPrompt(baseInput({ mode: 'plan', turnIndex: 0 }));
    expect(result.reminder).toContain('当前模式');
    expect(result.reminder).toContain('plan');
  });

  it('AC6: plan mode turnIndex=1 返回精简版（包含"mode: plan"）', () => {
    const result = buildSystemPrompt(baseInput({ mode: 'plan', turnIndex: 1 }));
    expect(result.reminder).toContain('mode: plan');
    expect(result.reminder).not.toContain('当前模式');
  });

  it('AC6: plan mode turnIndex=4（默认 N=4）返回完整版', () => {
    const result = buildSystemPrompt(baseInput({ mode: 'plan', turnIndex: 4 }));
    expect(result.reminder).toContain('当前模式');
    expect(result.reminder).toContain('plan');
  });
});

// ─── AC6a: reminderInterval 自定义 ────────────────────────────────────────

describe('buildSystemPrompt - reminderInterval', () => {
  it('AC6a: reminderInterval=2 时 turnIndex=2 返回完整版', () => {
    const result = buildSystemPrompt(baseInput({ mode: 'plan', turnIndex: 2, reminderInterval: 2 }));
    expect(result.reminder).toContain('当前模式');
  });

  it('AC6a: reminderInterval=2 时 turnIndex=1 返回精简版', () => {
    const result = buildSystemPrompt(baseInput({ mode: 'plan', turnIndex: 1, reminderInterval: 2 }));
    expect(result.reminder).toContain('mode: plan');
    expect(result.reminder).not.toContain('当前模式');
  });
});

// ─── AC6b: full mode 不含模式提醒 ─────────────────────────────────────────

describe('buildSystemPrompt - full mode 无模式提醒', () => {
  it('AC6b: full mode turnIndex=0 时 reminder 不含"mode"也不含"模式"', () => {
    const result = buildSystemPrompt(baseInput({ mode: 'full', turnIndex: 0 }));
    expect(result.reminder).not.toContain('mode');
    expect(result.reminder).not.toContain('模式');
  });
});

// ─── AC11: 幂等性 ─────────────────────────────────────────────────────────

describe('buildSystemPrompt - 幂等性', () => {
  it('AC11: 相同 input 调用两次，system 和 reminder 完全相等', () => {
    const input = baseInput({
      mode: 'plan',
      turnIndex: 2,
      env: { os: 'linux', shell: 'bash', cwd: '/home/user', date: '2026-01-01' },
    });
    const result1 = buildSystemPrompt(input);
    const result2 = buildSystemPrompt(input);
    expect(result1.system).toBe(result2.system);
    expect(result1.reminder).toBe(result2.reminder);
  });
});

// ─── AC13: env 上下文注入 reminder ────────────────────────────────────────

describe('buildSystemPrompt - env 上下文', () => {
  it('AC13: 传入 env 时 reminder 包含完整环境信息', () => {
    const result = buildSystemPrompt(
      baseInput({
        env: { os: 'win32', shell: 'powershell', cwd: '/tmp/project', date: '2026-07-08' },
      }),
    );
    expect(result.reminder).toContain('OS: win32 | Shell: powershell | CWD: /tmp/project | Date: 2026-07-08');
  });

  it('AC13: env 含 gitBranch 时 reminder 包含 Git 分支信息', () => {
    const result = buildSystemPrompt(
      baseInput({
        env: {
          os: 'linux',
          shell: 'bash',
          cwd: '/project',
          date: '2026-07-09',
          gitBranch: 'feat/test',
          gitDirty: false,
        },
      }),
    );
    expect(result.reminder).toContain('Git: feat/test');
    expect(result.reminder).not.toContain('[dirty]');
  });

  it('AC13: env 含 gitDirty=true 时 reminder 显示 [dirty] 标记', () => {
    const result = buildSystemPrompt(
      baseInput({
        env: { os: 'linux', shell: 'bash', cwd: '/project', date: '2026-07-09', gitBranch: 'main', gitDirty: true },
      }),
    );
    expect(result.reminder).toContain('Git: main [dirty]');
  });

  it('AC13: env 不含 gitBranch 时 reminder 不含 Git 信息', () => {
    const result = buildSystemPrompt(
      baseInput({
        env: { os: 'linux', shell: 'bash', cwd: '/project', date: '2026-07-09' },
      }),
    );
    expect(result.reminder).not.toContain('Git:');
  });
});
