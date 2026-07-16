import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { SessionArchive } from '../../../src/session/SessionArchive.js';
import type { ChatMessage as ProviderChatMessage } from '../../../src/providers/types.js';

describe('SessionArchive', () => {
  it('AC3: 按 JSONL 追加完整消息 schema，并只给文本消息写入 _ui', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-archive-'));
    const sessionsDir = join(root, '.agentcode', 'sessions');
    let id = 0;
    try {
      const archive = new SessionArchive({
        sessionsDir,
        now: () => 1_700_000_000_000,
        createUiId: (author) => `${author}-${++id}`,
        randomHex: () => 'a1b2',
      });
      const firstBatch: ProviderChatMessage[] = [
        { role: 'user', content: '读取文件' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', argumentsText: '{"path":"README.md"}' }],
        },
      ];
      const secondBatch: ProviderChatMessage[] = [
        { role: 'tool', toolCallId: 'call-1', toolName: 'read_file', content: 'ok', isError: false },
        { role: 'assistant', content: '读取完成' },
      ];

      await archive.append(firstBatch);
      await archive.append(secondBatch);

      expect(archive.sessionId).toMatch(/^\d{8}-\d{6}-a1b2$/);
      expect(archive.filePath).toBe(join(sessionsDir, `${archive.sessionId}.jsonl`));
      const lines = (await readFile(archive.filePath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatchObject({
        role: 'user',
        content: '读取文件',
        _ts: 1_700_000_000_000,
        _ui: { id: 'user-1', createdAt: 1_700_000_000_000, author: 'user' },
      });
      expect(lines[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call-1' }] });
      expect(lines[1]).not.toHaveProperty('_ui');
      expect(lines[2]).toMatchObject({
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'read_file',
        isError: false,
      });
      expect(lines[2]).not.toHaveProperty('_ui');
      expect(lines[3]).toMatchObject({
        role: 'assistant',
        content: '读取完成',
        _ui: { id: 'agent-2', author: 'agent' },
      });

      if (process.platform !== 'win32') {
        expect((await stat(sessionsDir)).mode & 0o777).toBe(0o700);
        expect((await stat(archive.filePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('恢复续写时先修复孤立工具调用坏尾，并处理原文件缺少末尾换行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-archive-resume-'));
    const sessionsDir = join(root, '.agentcode', 'sessions');
    const sessionId = '20260102-030405-dead';
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    const validLine = JSON.stringify({
      role: 'user',
      content: '旧消息',
      _ts: 1,
      _ui: { id: 'old-user', createdAt: 1, author: 'user' },
    });
    const orphanLine = JSON.stringify({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'orphan', name: 'read_file', argumentsText: '{}' }],
      _ts: 2,
    });
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(filePath, `${validLine}\n${orphanLine}`, 'utf8');
      const repairOffset = Buffer.byteLength(`${validLine}\n`, 'utf8');
      const before = await stat(filePath);
      const archive = new SessionArchive({
        sessionsDir,
        resume: {
          sessionId,
          repairOffset,
          expectedFile: {
            size: before.size,
            mtimeMs: before.mtimeMs,
            dev: before.dev,
            ino: before.ino,
          },
        },
        now: () => 3,
        createUiId: (author) => `new-${author}`,
      });

      await archive.append([
        { role: 'user', content: '新消息' },
        { role: 'assistant', content: '新回复' },
      ]);

      const content = await readFile(filePath, 'utf8');
      expect(content).not.toContain('orphan');
      expect(content.trimEnd().split('\n')).toHaveLength(3);
      expect(content).toContain('新消息');
      expect(content).toContain('新回复');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('拒绝用陈旧 repairOffset 截断其他进程已追加的有效消息', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-archive-stale-'));
    const sessionsDir = join(root, '.agentcode', 'sessions');
    const sessionId = '20260102-030405-beef';
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    const validLine = JSON.stringify({ role: 'user', content: 'old', _ts: 1 });
    const orphanLine = JSON.stringify({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'orphan', name: 'read_file', argumentsText: '{}' }],
      _ts: 2,
    });
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(filePath, `${validLine}\n${orphanLine}\n`, 'utf8');
      const before = await stat(filePath);
      const archive = new SessionArchive({
        sessionsDir,
        resume: {
          sessionId,
          repairOffset: Buffer.byteLength(`${validLine}\n`, 'utf8'),
          expectedFile: {
            size: before.size,
            mtimeMs: before.mtimeMs,
            dev: before.dev,
            ino: before.ino,
          },
        },
      });
      await writeFile(filePath, `${validLine}\n${orphanLine}\n${JSON.stringify({ role: 'user', content: 'other' })}\n`, 'utf8');

      await archive.append([{ role: 'assistant', content: 'must not overwrite' }]);

      const content = await readFile(filePath, 'utf8');
      expect(content).toContain('other');
      expect(content).not.toContain('must not overwrite');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('安全增强: 不追加 hardlink 归档，也不跟随 .agentcode 目录 junction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-archive-links-'));
    const project = join(root, 'project');
    const sessionsDir = join(project, '.agentcode', 'sessions');
    const outsideFile = join(root, 'outside.jsonl');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(outsideFile, 'outside-original', 'utf8');
      const archive = new SessionArchive({ sessionsDir, now: () => 1_700_000_000_000, randomHex: () => 'cafe' });
      await link(outsideFile, archive.filePath);
      await archive.append([{ role: 'user', content: 'must not append' }]);
      expect(await readFile(outsideFile, 'utf8')).toBe('outside-original');

      await rm(join(project, '.agentcode'), { recursive: true, force: true });
      const outsideAgentcode = join(root, 'outside-agentcode');
      await mkdir(outsideAgentcode, { recursive: true });
      await mkdir(project, { recursive: true });
      await symlink(outsideAgentcode, join(project, '.agentcode'), process.platform === 'win32' ? 'junction' : 'dir');
      const junctionArchive = new SessionArchive({
        sessionsDir,
        now: () => 1_700_000_000_000,
        randomHex: () => 'f00d',
      });
      await junctionArchive.append([{ role: 'user', content: 'must stay inside project' }]);
      await expect(readFile(join(outsideAgentcode, 'sessions', `${junctionArchive.sessionId}.jsonl`), 'utf8')).rejects.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});
