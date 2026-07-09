import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { loadDynamicModules } from '../../../src/system-prompt/loadDynamicModules.js';

describe('loadDynamicModules', () => {
  it('无 .agentcode 目录时返回默认注册表（custom-instructions 和 memory 为空）', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    try {
      const registry = await loadDynamicModules(tempDir);
      const projectContext = registry.find(m => m.id === 'project-context');
      const custom = registry.find(m => m.id === 'custom-instructions');
      const memory = registry.find(m => m.id === 'memory');
      expect(projectContext).toBeDefined();
      expect(projectContext!.content).toBe('');
      expect(custom).toBeDefined();
      expect(custom!.content).toBe('');
      expect(memory).toBeDefined();
      expect(memory!.content).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('存在 instructions.md 时注入 custom-instructions 模块', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    const configDir = join(tempDir, '.agentcode');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'instructions.md'), '优先使用中文回答');
    try {
      const registry = await loadDynamicModules(tempDir);
      const custom = registry.find(m => m.id === 'custom-instructions');
      expect(custom!.content).toContain('优先使用中文回答');
      expect(custom!.content).toContain('用户自定义指令');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('存在 memory.md 时注入 memory 模块', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    const configDir = join(tempDir, '.agentcode');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'memory.md'), '用户偏好 vim 操作');
    try {
      const registry = await loadDynamicModules(tempDir);
      const memory = registry.find(m => m.id === 'memory');
      expect(memory!.content).toContain('用户偏好 vim 操作');
      expect(memory!.content).toContain('持久化记忆');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('存在项目根 CLAUDE.md 时注入 project-context 模块', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    await writeFile(join(tempDir, 'CLAUDE.md'), '# 项目规则\n优先使用中文');
    try {
      const registry = await loadDynamicModules(tempDir);
      const projectContext = registry.find(m => m.id === 'project-context');
      expect(projectContext!.content).toContain('# 项目规则');
      expect(projectContext!.content).toContain('项目上下文（CLAUDE.md）');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('CLAUDE.md 和 .agentcode/instructions.md 同时存在时各自注入独立模块', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    const configDir = join(tempDir, '.agentcode');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(tempDir, 'CLAUDE.md'), '项目级规则');
    await writeFile(join(configDir, 'instructions.md'), '用户级指令');
    try {
      const registry = await loadDynamicModules(tempDir);
      const projectContext = registry.find(m => m.id === 'project-context');
      const custom = registry.find(m => m.id === 'custom-instructions');
      expect(projectContext!.content).toContain('项目级规则');
      expect(custom!.content).toContain('用户级指令');
      // 两者不互相污染
      expect(projectContext!.content).not.toContain('用户级指令');
      expect(custom!.content).not.toContain('项目级规则');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('从子目录启动时向上遍历找到祖先目录的 CLAUDE.md', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    const subDir = join(tempDir, 'packages', 'foo');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(tempDir, 'CLAUDE.md'), '# 根目录规则');
    try {
      const registry = await loadDynamicModules(subDir);
      const projectContext = registry.find(m => m.id === 'project-context');
      expect(projectContext!.content).toContain('# 根目录规则');
      expect(projectContext!.content).toContain('项目上下文（CLAUDE.md）');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('超过 16KB 的 CLAUDE.md 被截断并添加提示', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    const largeContent = 'x'.repeat(20 * 1024);
    await writeFile(join(tempDir, 'CLAUDE.md'), largeContent);
    try {
      const registry = await loadDynamicModules(tempDir);
      const projectContext = registry.find(m => m.id === 'project-context');
      expect(projectContext!.content).toContain('...(truncated)');
      expect(projectContext!.content.length).toBeLessThan(20 * 1024);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('超过 4KB 的文件被截断并添加提示', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    const configDir = join(tempDir, '.agentcode');
    await mkdir(configDir, { recursive: true });
    // 写入一个超过 4KB 的文件
    const largeContent = 'x'.repeat(5000);
    await writeFile(join(configDir, 'instructions.md'), largeContent);
    try {
      const registry = await loadDynamicModules(tempDir);
      const custom = registry.find(m => m.id === 'custom-instructions');
      expect(custom!.content).toContain('...(truncated)');
      // 内容应被截断
      expect(custom!.content.length).toBeLessThan(5000);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('保持模块顺序不变', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentcode-test-'));
    try {
      const registry = await loadDynamicModules(tempDir);
      const orders = registry.map(m => m.order);
      // 验证 order 值序列保持递增
      for (let i = 1; i < orders.length; i++) {
        expect(orders[i]!).toBeGreaterThanOrEqual(orders[i - 1]!);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
