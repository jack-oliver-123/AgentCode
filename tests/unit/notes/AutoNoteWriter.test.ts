import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutoNoteWriter } from '../../../src/notes/AutoNoteWriter.js';
import { FakeProvider } from '../../helpers/FakeProvider.js';
import type { ProviderEvent } from '../../../src/providers/types.js';

describe('AutoNoteWriter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC6: 中文纠正关键词触发项目笔记和索引写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-keyword-'));
    const provider = new FakeProvider(noteResponse([addOperation()]));
    try {
      const writer = createWriter(root, provider);

      await writer.maybeUpdate({
        userText: '以后不要用 any 类型',
        assistantText: '收到。',
        completionTokens: 0,
      });

      const memoryDir = join(root, 'project', '.agentcode', 'memory');
      const note = await readFile(join(memoryDir, 'no-any.md'), 'utf8');
      const index = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8');
      expect(note).toContain('metadata:\n  type: feedback');
      expect(note).toContain('禁止 any');
      expect(index).toContain('- [不要使用 any](no-any.md) — 项目不使用 any 类型');
      expect(index.trim().split('\n')).toHaveLength(1);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.messages[0]?.content).toContain('以后不要用 any 类型');

      if (process.platform !== 'win32') {
        expect((await stat(memoryDir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(memoryDir, 'no-any.md'))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC6: completionTokens > 200 且含围栏代码时触发，并解析被围栏包裹的 JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-code-'));
    const response = `\`\`\`json\n${JSON.stringify([addOperation({ filename: 'code-style', title: '代码风格' })])}\n\`\`\``;
    const provider = new FakeProvider(textResponse(response));
    try {
      const writer = createWriter(root, provider);
      await writer.maybeUpdate({
        userText: '请实现这个功能',
        assistantText: '实现如下：\n```ts\nconst value = 1;\n```',
        completionTokens: 300,
      });

      await expect(readFile(join(root, 'project', '.agentcode', 'memory', 'code-style.md'), 'utf8')).resolves.toContain(
        'name: code-style',
      );
      await expect(readFile(join(root, 'project', '.agentcode', 'memory', 'MEMORY.md'), 'utf8')).resolves.toContain(
        '[代码风格](code-style.md)',
      );
      expect(provider.requests).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('AC6: 高 token 但没有围栏代码时不调用 LLM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-skip-'));
    const provider = new FakeProvider(noteResponse([addOperation()]));
    try {
      const writer = createWriter(root, provider);
      await writer.maybeUpdate({
        userText: '请解释一下',
        assistantText: '这是一段很长但没有代码围栏的回答。',
        completionTokens: 300,
      });

      expect(provider.requests).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delete 只移除索引条目，保留笔记文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-delete-'));
    const memoryDir = join(root, 'project', '.agentcode', 'memory');
    const provider = new FakeProvider(
      noteResponse([
        {
          ...addOperation(),
          op: 'delete',
        },
      ]),
    );
    try {
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'no-any.md'), '保留此文件', 'utf8');
      await writeFile(join(memoryDir, 'MEMORY.md'), '- [不要使用 any](no-any.md) — 项目不使用 any 类型', 'utf8');
      const writer = createWriter(root, provider);

      await writer.maybeUpdate({ userText: '记住删除这条索引', assistantText: '好', completionTokens: 0 });

      await expect(readFile(join(memoryDir, 'no-any.md'), 'utf8')).resolves.toBe('保留此文件');
      await expect(readFile(join(memoryDir, 'MEMORY.md'), 'utf8')).resolves.toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('索引超过 200 行时最多通过裁剪请求移除一条并原子重建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-prune-'));
    const memoryDir = join(root, 'project', '.agentcode', 'memory');
    const existing = Array.from(
      { length: 200 },
      (_, index) => `- [旧条目 ${index}](old-${index}.md) — 摘要 ${index}`,
    ).join('\n');
    const provider = new FakeProvider([
      noteResponse([addOperation()]),
      textResponse(JSON.stringify({ level: 'project', filename: 'old-0.md' })),
    ]);
    try {
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'MEMORY.md'), existing, 'utf8');
      const writer = createWriter(root, provider);

      await writer.maybeUpdate({ userText: '以后不要用 any', assistantText: '好', completionTokens: 0 });

      const index = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8');
      expect(index.trim().split('\n')).toHaveLength(200);
      expect(index).not.toContain('(old-0.md)');
      expect(index).toContain('(no-any.md)');
      expect(provider.requests).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('三次裁剪响应均无效时保留原有合规索引，不提交第 201 行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-prune-invalid-'));
    const memoryDir = join(root, 'project', '.agentcode', 'memory');
    const existing = Array.from(
      { length: 200 },
      (_, index) => `- [旧条目 ${index}](old-${index}.md) — 摘要 ${index}`,
    ).join('\n');
    const provider = new FakeProvider([
      noteResponse([addOperation()]),
      textResponse('invalid'),
      textResponse('invalid'),
      textResponse('invalid'),
    ]);
    try {
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'MEMORY.md'), existing, 'utf8');

      await createWriter(root, provider).maybeUpdate({
        userText: '以后不要用 any',
        assistantText: '好',
        completionTokens: 0,
      });

      expect(await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(existing);
      expect(provider.requests).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('LLM JSON 无效或 filename 越界时只记录 warn，不写出 memory 目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-invalid-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalidJsonProvider = new FakeProvider(textResponse('not-json'));
    try {
      await createWriter(root, invalidJsonProvider).maybeUpdate({
        userText: '以后记住这个',
        assistantText: '好',
        completionTokens: 0,
      });
      expect(warn).toHaveBeenCalled();

      const traversalProvider = new FakeProvider(noteResponse([addOperation({ filename: '../outside' })]));
      await createWriter(root, traversalProvider).maybeUpdate({
        userText: '以后记住另一个',
        assistantText: '好',
        completionTokens: 0,
      });
      await expect(readFile(join(root, 'project', '.agentcode', 'outside.md'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('拒绝会破坏 Markdown 索引语法的文件名，并保留既有安全条目', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-parentheses-'));
    const memoryDir = join(root, 'project', '.agentcode', 'memory');
    const provider = new FakeProvider(
      noteResponse([addOperation({ filename: 'api(v2)', title: 'API v2' })]),
    );
    try {
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'MEMORY.md'), '- [API v1](api-v1.md) — existing', 'utf8');
      await createWriter(root, provider).maybeUpdate({
        userText: '以后记住 API v2',
        assistantText: '好',
        completionTokens: 0,
      });

      const index = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8');
      expect(index).toContain('(api-v1.md)');
      expect(index).not.toContain('api(v2)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('安全增强: 自动笔记不跟随项目 .agentcode junction 写入外部目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-note-junction-'));
    const project = join(root, 'project');
    const outsideAgentcode = join(root, 'outside-agentcode');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await mkdir(project, { recursive: true });
      await mkdir(outsideAgentcode, { recursive: true });
      await symlink(outsideAgentcode, join(project, '.agentcode'), process.platform === 'win32' ? 'junction' : 'dir');
      const provider = new FakeProvider(noteResponse([addOperation()]));
      await createWriter(root, provider).maybeUpdate({
        userText: '以后不要用 any',
        assistantText: '好',
        completionTokens: 0,
      });

      await expect(readFile(join(outsideAgentcode, 'memory', 'no-any.md'), 'utf8')).rejects.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createWriter(root: string, provider: FakeProvider): AutoNoteWriter {
  mkdirSync(join(root, 'project'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  return new AutoNoteWriter({
    provider,
    model: 'test-model',
    timeoutMs: 1000,
    cwd: join(root, 'project'),
    homeDir: join(root, 'home'),
  });
}

function addOperation(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    op: 'add',
    level: 'project',
    title: '不要使用 any',
    filename: 'no-any',
    summary: '项目不使用 any 类型',
    type: 'feedback',
    body: '禁止 any',
    ...overrides,
  };
}

function noteResponse(operations: Record<string, string>[]): ProviderEvent[] {
  return textResponse(JSON.stringify(operations));
}

function textResponse(text: string): ProviderEvent[] {
  return [
    { type: 'content.delta', delta: text },
    { type: 'response.complete', finishReason: 'stop' },
  ];
}
