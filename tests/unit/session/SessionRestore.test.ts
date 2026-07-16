import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listSessions, loadSession } from '../../../src/session/SessionRestore.js';

describe('SessionRestore', () => {
  it('AC4: 跳过坏行，从孤立工具调用处截断，并返回 repairOffset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-restore-invalid-'));
    const filePath = join(root, '20260102-030405-abcd.jsonl');
    const firstLine = archivedText('user', '有效用户消息', 1, 'u-1');
    const secondLine = archivedText('assistant', '有效回复', 2, 'a-1');
    const orphanLine = JSON.stringify({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'orphan-call', name: 'read_file', argumentsText: '{}' }],
      _ts: 3,
    });
    const raw = `${firstLine}\n{bad-json\n${secondLine}\n${orphanLine}\n${archivedText('user', '应被截断', 4, 'u-2')}\n`;
    try {
      await writeFile(filePath, raw, 'utf8');

      const restored = await loadSession(filePath);

      expect(restored.providerContext).toEqual([
        { role: 'user', content: '有效用户消息' },
        { role: 'assistant', content: '有效回复' },
      ]);
      expect(restored.messages.map((message) => message.parts[0])).toEqual([
        { type: 'text', text: '有效用户消息' },
        { type: 'text', text: '有效回复' },
      ]);
      expect(restored.source?.sessionId).toBe('20260102-030405-abcd');
      expect(restored.source?.repairOffset).toBe(Buffer.byteLength(`${firstLine}\n{bad-json\n${secondLine}\n`, 'utf8'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC4: 在完整 turn 边界插入超过 24 小时的合成 user 提醒', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-restore-gap-'));
    const filePath = join(root, '20260102-030405-abcd.jsonl');
    const firstTs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const secondTs = firstTs + 25 * 60 * 60 * 1000;
    try {
      await writeFile(
        filePath,
        [
          archivedText('user', '第一段', firstTs, 'u-1'),
          archivedText('assistant', '第一段回复', firstTs + 1000, 'a-1'),
          archivedText('user', '第二段', secondTs, 'u-2'),
          archivedText('assistant', '第二段回复', secondTs + 1000, 'a-2'),
        ].join('\n'),
        'utf8',
      );

      const restored = await loadSession(filePath);
      const reminder = restored.providerContext[2];

      expect(reminder).toMatchObject({ role: 'user' });
      expect(reminder?.content).toMatch(/^\[距上次对话已超过 25 小时，本段对话发生于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/);
      expect(restored.providerContext[3]).toEqual({ role: 'user', content: '第二段' });
      expect(restored.messages).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('工具调用与结果跨 24 小时时将提醒延后到工具链闭合后的安全边界', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-restore-tool-gap-'));
    const filePath = join(root, '20260102-030405-abcd.jsonl');
    const firstTs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const secondTs = firstTs + 25 * 60 * 60 * 1000;
    try {
      await writeFile(
        filePath,
        [
          archivedText('user', '执行工具', firstTs, 'u-1'),
          JSON.stringify({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-gap', name: 'read_file', argumentsText: '{}' }],
            _ts: firstTs + 1,
          }),
          JSON.stringify({
            role: 'tool',
            toolCallId: 'call-gap',
            toolName: 'read_file',
            content: 'ok',
            isError: false,
            _ts: secondTs,
          }),
          archivedText('assistant', '完成', secondTs + 1, 'a-1'),
        ].join('\n'),
        'utf8',
      );

      const restored = await loadSession(filePath);
      expect(restored.providerContext.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
      ]);
      expect(restored.providerContext[3]?.content).toContain('距上次对话已超过 25 小时');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('保留完整的多工具调用结果链，并显式剥离归档元数据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-restore-tools-'));
    const filePath = join(root, '20260102-030405-abcd.jsonl');
    try {
      const lines = [
        archivedText('user', '执行工具', 1, 'u-1'),
        JSON.stringify({
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'read_file', argumentsText: '{}' },
            { id: 'call-2', name: 'glob_files', argumentsText: '{}' },
          ],
          _ts: 2,
        }),
        JSON.stringify({ role: 'tool', toolCallId: 'call-2', toolName: 'glob_files', content: 'b', isError: false, _ts: 3 }),
        JSON.stringify({ role: 'tool', toolCallId: 'call-1', toolName: 'read_file', content: 'a', isError: false, _ts: 4 }),
        archivedText('assistant', '完成', 5, 'a-1'),
      ];
      await writeFile(filePath, lines.join('\n'), 'utf8');

      const restored = await loadSession(filePath);

      expect(restored.providerContext).toHaveLength(5);
      expect(restored.providerContext[1]).toMatchObject({ toolCalls: [{ id: 'call-1' }, { id: 'call-2' }] });
      expect(restored.providerContext[1]).not.toHaveProperty('_ts');
      expect(restored.providerContext[2]).not.toHaveProperty('_ui');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('没有可选 _ui 的文本归档仍恢复到 Provider，但不伪造 TUI 消息', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-restore-no-ui-'));
    const filePath = join(root, '20260102-030405-abcd.jsonl');
    try {
      await writeFile(
        filePath,
        [
          JSON.stringify({ role: 'user', content: 'provider only', _ts: 1 }),
          JSON.stringify({ role: 'assistant', content: 'provider reply', _ts: 2 }),
        ].join('\n'),
        'utf8',
      );

      const restored = await loadSession(filePath);
      expect(restored.providerContext).toEqual([
        { role: 'user', content: 'provider only' },
        { role: 'assistant', content: 'provider reply' },
      ]);
      expect(restored.messages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('扫描普通 JSONL 文件，按 mtime 倒序返回最近 10 条和合法消息数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-restore-list-'));
    const sessionsDir = join(root, '.agentcode', 'sessions');
    const baseTime = new Date('2026-01-01T00:00:00.000Z');
    try {
      await mkdir(sessionsDir, { recursive: true });
      for (let index = 0; index < 12; index++) {
        const id = `202601${String(index + 1).padStart(2, '0')}-030405-${index.toString(16).padStart(4, '0')}`;
        const path = join(sessionsDir, `${id}.jsonl`);
        await writeFile(path, `${archivedText('user', `message-${index}`, index + 1, `u-${index}`)}\n{bad`, 'utf8');
        const modified = new Date(baseTime.getTime() + index * 1000);
        await utimes(path, modified, modified);
      }
      await writeFile(join(sessionsDir, 'ignore.txt'), 'ignored', 'utf8');

      const summaries = await listSessions(root);

      expect(summaries).toHaveLength(10);
      expect(summaries[0]?.sessionId).toContain('20260112');
      expect(summaries[0]?.messageCount).toBe(1);
      expect(summaries[9]?.sessionId).toContain('20260103');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function archivedText(role: 'user' | 'assistant', content: string, timestamp: number, id: string): string {
  return JSON.stringify({
    role,
    content,
    _ts: timestamp,
    _ui: { id, createdAt: timestamp, author: role === 'user' ? 'user' : 'agent' },
  });
}
