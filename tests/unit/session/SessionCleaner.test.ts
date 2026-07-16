import { access, link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { maybeClean } from '../../../src/session/SessionCleaner.js';

describe('SessionCleaner', () => {
  it('AC5: 超过 7 天时异步删除 30 天前会话并写回 ISO 时间', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-cleaner-'));
    const agentcodeDir = join(root, '.agentcode');
    const sessionsDir = join(agentcodeDir, 'sessions');
    const now = new Date('2026-07-16T00:00:00.000Z');
    const oldFile = join(sessionsDir, 'old.jsonl');
    const recentFile = join(sessionsDir, 'recent.jsonl');
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(agentcodeDir, 'last_cleanup'), new Date(now.getTime() - 8 * DAY).toISOString(), 'utf8');
      await writeFile(oldFile, '{}', 'utf8');
      await writeFile(recentFile, '{}', 'utf8');
      const oldTime = new Date(now.getTime() - 31 * DAY);
      const recentTime = new Date(now.getTime() - 2 * DAY);
      await utimes(oldFile, oldTime, oldTime);
      await utimes(recentFile, recentTime, recentTime);

      const cleanup = maybeClean(root, { now: () => now.getTime() });
      expect(cleanup).toBeInstanceOf(Promise);
      await cleanup;

      await expect(access(oldFile)).rejects.toThrow();
      await expect(access(recentFile)).resolves.toBeUndefined();
      expect(await readFile(join(agentcodeDir, 'last_cleanup'), 'utf8')).toBe(now.toISOString());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sessions 目录不存在时仍完成清理标记，近期清理则直接跳过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-cleaner-empty-'));
    const now = new Date('2026-07-16T00:00:00.000Z');
    try {
      await maybeClean(root, { now: () => now.getTime() });
      expect(await readFile(join(root, '.agentcode', 'last_cleanup'), 'utf8')).toBe(now.toISOString());

      await writeFile(join(root, '.agentcode', 'last_cleanup'), new Date(now.getTime() - DAY).toISOString(), 'utf8');
      await maybeClean(root, { now: () => now.getTime() });
      expect(await readFile(join(root, '.agentcode', 'last_cleanup'), 'utf8')).toBe(
        new Date(now.getTime() - DAY).toISOString(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sessions 扫描失败时记录 warn 且不写入清理成功时间', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-cleaner-failure-'));
    const agentcodeDir = join(root, '.agentcode');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await mkdir(agentcodeDir, { recursive: true });
      await writeFile(join(agentcodeDir, 'sessions'), 'not a directory', 'utf8');
      await maybeClean(root, { now: () => new Date('2026-07-16T00:00:00.000Z').getTime() });

      expect(warn).toHaveBeenCalled();
      await expect(access(join(agentcodeDir, 'last_cleanup'))).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('安全增强: 不跟随项目 .agentcode junction 删除外部旧会话', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-cleaner-junction-'));
    const project = join(root, 'project');
    const outsideAgentcode = join(root, 'outside-agentcode');
    const outsideSessions = join(outsideAgentcode, 'sessions');
    const outsideFile = join(outsideSessions, 'old.jsonl');
    const now = new Date('2026-07-16T00:00:00.000Z');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await mkdir(outsideSessions, { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(outsideFile, '{}', 'utf8');
      const oldTime = new Date(now.getTime() - 31 * DAY);
      await utimes(outsideFile, oldTime, oldTime);
      await symlink(outsideAgentcode, join(project, '.agentcode'), process.platform === 'win32' ? 'junction' : 'dir');

      await maybeClean(project, { now: () => now.getTime() });

      await expect(access(outsideFile)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('安全增强: 原子替换 hardlink last_cleanup，不覆盖外部链接目标', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-cleaner-hardlink-'));
    const project = join(root, 'project');
    const agentcodeDir = join(project, '.agentcode');
    const outsideFile = join(root, 'outside-marker.txt');
    const now = new Date('2026-07-16T00:00:00.000Z');
    try {
      await mkdir(agentcodeDir, { recursive: true });
      await writeFile(outsideFile, 'outside-original', 'utf8');
      await link(outsideFile, join(agentcodeDir, 'last_cleanup'));

      await maybeClean(project, { now: () => now.getTime() });

      expect(await readFile(outsideFile, 'utf8')).toBe('outside-original');
      expect(await readFile(join(agentcodeDir, 'last_cleanup'), 'utf8')).toBe(now.toISOString());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const DAY = 24 * 60 * 60 * 1000;
