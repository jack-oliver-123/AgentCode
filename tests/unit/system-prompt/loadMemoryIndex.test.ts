import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadMemoryIndex, loadMemoryIndexes } from '../../../src/system-prompt/loadMemoryIndex.js';

describe('loadMemoryIndex', () => {
  it('读取用户级和项目级 MEMORY.md，并按用户级在前的顺序合并', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-memory-index-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    try {
      await writeText(join(home, '.agentcode', 'memory', 'MEMORY.md'), '- [用户偏好](user.md) — 使用中文');
      await writeText(join(project, '.agentcode', 'memory', 'MEMORY.md'), '- [项目决策](project.md) — 使用 ESM');

      const levels = await loadMemoryIndexes(project, home);
      const content = await loadMemoryIndex(project, home);

      expect(levels).toEqual({
        user: '- [用户偏好](user.md) — 使用中文',
        project: '- [项目决策](project.md) — 使用 ESM',
      });
      expect(content).toContain('用户级记忆索引');
      expect(content).toContain('项目级记忆索引');
      expect(content.indexOf('用户偏好')).toBeLessThan(content.indexOf('项目决策'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('文件缺失或读取失败时返回空内容且不抛出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-memory-missing-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    try {
      await mkdir(project, { recursive: true });
      await expect(loadMemoryIndexes(project, home)).resolves.toEqual({ user: '', project: '' });
      await expect(loadMemoryIndex(project, home)).resolves.toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('安全增强: 拒绝 hardlink MEMORY.md 和越界 memory 目录 junction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-memory-links-'));
    const project = join(root, 'project');
    const home = join(root, 'home');
    const outsideFile = join(root, 'outside.md');
    const projectMemory = join(project, '.agentcode', 'memory');
    try {
      await writeText(outsideFile, '不应注入的 hardlink 内容');
      await mkdir(projectMemory, { recursive: true });
      await link(outsideFile, join(projectMemory, 'MEMORY.md'));
      await expect(loadMemoryIndex(project, home)).resolves.toBe('');

      await rm(projectMemory, { recursive: true, force: true });
      const outsideDirectory = join(root, 'outside-memory');
      await writeText(join(outsideDirectory, 'MEMORY.md'), '不应注入的 junction 内容');
      await symlink(outsideDirectory, projectMemory, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(loadMemoryIndex(project, home)).resolves.toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}
