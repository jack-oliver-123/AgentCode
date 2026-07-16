import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadProjectRules, resolveIncludes } from '../../../src/system-prompt/loadProjectRules.js';
import { defaultRegistry } from '../../../src/system-prompt/registry.js';

const PROJECT_RULES_MAX_BYTES = 25 * 1024;

describe('loadProjectRules', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC1: 按项目具体层、项目根层、全局层的顺序加载规则', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-order-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    try {
      await writeText(join(project, '.agentcode', 'AGENTCODE.md'), '规则 B：项目具体层');
      await writeText(join(project, 'AGENTCODE.md'), '规则 A：项目根层');
      await writeText(join(home, '.agentcode', 'AGENTCODE.md'), '规则 C：全局层');

      const content = await loadProjectRules(project, home);

      expect(content).toContain('规则 A');
      expect(content).toContain('规则 B');
      expect(content).toContain('规则 C');
      expect(content.indexOf('规则 B')).toBeLessThan(content.indexOf('规则 A'));
      expect(content.indexOf('规则 A')).toBeLessThan(content.indexOf('规则 C'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC1: 仅全局规则存在时正常加载，三层均缺失时返回空字符串', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-global-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    try {
      await mkdir(project, { recursive: true });
      await writeText(join(home, '.agentcode', 'AGENTCODE.md'), '仅全局规则');

      await expect(loadProjectRules(project, home)).resolves.toContain('仅全局规则');
      await rm(join(home, '.agentcode', 'AGENTCODE.md'));
      await expect(loadProjectRules(project, home)).resolves.toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T1: registry 在 project-context 与 custom-instructions 之间包含 project-rules slot', () => {
    const slot = defaultRegistry.find((module) => module.id === 'project-rules');
    expect(slot).toEqual({ id: 'project-rules', order: 660, content: '' });

    const ids = defaultRegistry.map((module) => module.id);
    expect(ids.indexOf('project-context')).toBeLessThan(ids.indexOf('project-rules'));
    expect(ids.indexOf('project-rules')).toBeLessThan(ids.indexOf('custom-instructions'));
  });

  it('AC2: 展开项目内 include，并保留 include 前后的内容', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-include-'));
    const project = join(root, 'project');
    try {
      await writeText(join(project, 'utils', 'shared.md'), '共享规则内容');
      await writeText(join(project, 'AGENTCODE.md'), '开始\n@include utils/shared.md\n结束');

      await expect(loadProjectRules(project, join(root, 'home'))).resolves.toContain('开始\n共享规则内容\n结束');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC2/AC8: 越界 include 记录路径并跳过，文件其余内容继续加载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-boundary-'));
    const project = join(root, 'project');
    const outside = join(root, 'sensitive.md');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeText(outside, '不应读取的敏感内容');
      await writeText(join(project, 'AGENTCODE.md'), '安全前缀\n@include ../sensitive.md\n安全后缀');

      const content = await loadProjectRules(project, join(root, 'home'));

      expect(content).toContain('安全前缀');
      expect(content).toContain('安全后缀');
      expect(content).not.toContain('不应读取的敏感内容');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sensitive.md'), expect.any(Error));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC8: 未提供 warning handler 时，resolveIncludes 对越界路径抛出明确错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-throw-'));
    const project = join(root, 'project');
    try {
      await mkdir(project, { recursive: true });
      await expect(resolveIncludes('@include ../sensitive.md', project, project)).rejects.toThrow(/sensitive\.md/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC2: 全局规则不能 include ~/.agentcode 之外的文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-global-boundary-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeText(join(home, 'outside.md'), '全局边界之外');
      await writeText(join(home, '.agentcode', 'AGENTCODE.md'), '全局前缀\n@include ../outside.md\n全局后缀');

      const content = await loadProjectRules(project, home);

      expect(content).toContain('全局前缀');
      expect(content).toContain('全局后缀');
      expect(content).not.toContain('全局边界之外');
      expect(warn).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC2: include 环路被跳过，最大深度 4 不加载第 5 层', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-depth-'));
    const project = join(root, 'project');
    try {
      await writeText(join(project, 'AGENTCODE.md'), 'ROOT\n@include b.md');
      await writeText(join(project, 'b.md'), 'B\n@include c.md');
      await writeText(join(project, 'c.md'), 'C\n@include d.md\n@include AGENTCODE.md');
      await writeText(join(project, 'd.md'), 'D\n@include e.md');
      await writeText(join(project, 'e.md'), 'E\n@include f.md');
      await writeText(join(project, 'f.md'), 'F-第5层不应出现');

      const content = await loadProjectRules(project, join(root, 'home'));

      expect(content).toContain('ROOT');
      expect(content).toContain('B');
      expect(content).toContain('C');
      expect(content).toContain('D');
      expect(content).toContain('E');
      expect(content).not.toContain('F-第5层不应出现');
      expect(content.match(/ROOT/g)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('F3: 单个规则文件超过 25KB 时在 UTF-8 边界截断并追加标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-truncate-'));
    const project = join(root, 'project');
    try {
      await writeText(join(project, 'AGENTCODE.md'), '你'.repeat(PROJECT_RULES_MAX_BYTES));

      const content = await loadProjectRules(project, join(root, 'home'));

      expect(content).toContain('...(truncated)');
      expect(content).not.toContain('\uFFFD');
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(PROJECT_RULES_MAX_BYTES + 64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('安全增强: 项目内 symlink 不能 include 项目外文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-symlink-'));
    const project = join(root, 'project');
    const outside = join(root, 'outside.md');
    const link = join(project, 'linked.md');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeText(outside, 'symlink 外部内容');
      await mkdir(dirname(link), { recursive: true });
      await symlink(outside, link, 'file');
      await writeText(join(project, 'AGENTCODE.md'), '@include linked.md');

      const content = await loadProjectRules(project, join(root, 'home'));

      expect(content).not.toContain('symlink 外部内容');
      expect(warn).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('安全增强: 项目内目录 junction 不能 include 项目外文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-rules-junction-'));
    const project = join(root, 'project');
    const outsideDirectory = join(root, 'outside-dir');
    const linkedDirectory = join(project, 'linked-dir');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeText(join(outsideDirectory, 'secret.md'), 'junction 外部内容');
      await mkdir(project, { recursive: true });
      await symlink(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      await writeText(join(project, 'AGENTCODE.md'), '@include linked-dir/secret.md');

      const content = await loadProjectRules(project, join(root, 'home'));
      expect(content).not.toContain('junction 外部内容');
      expect(warn).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}
