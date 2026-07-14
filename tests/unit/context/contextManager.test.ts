import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { ContextManager } from '../../../src/context/ContextManager.js';
import type { ChatModelProvider, ChatMessage } from '../../../src/providers/types.js';

// 最小 mock provider，T2 阶段不使用 stream
const mockProvider = {} as ChatModelProvider;

function makeManager(cacheDir: string, contextWindow = 128000) {
  return new ContextManager(mockProvider, 'test-model', {
    contextWindow,
    offloadThresholdBytes: 8192,
    turnOffloadThresholdBytes: 32768,
    cacheDir,
    timeoutMs: 30000,
  });
}

describe('ContextManager - F1 token 估算', () => {
  it('初始 estimated === 0', () => {
    const mgr = makeManager('/tmp/test-cache');
    expect(mgr.estimated).toBe(0);
  });

  it('onMessagesAppended(400) 后 estimated === 100', () => {
    const mgr = makeManager('/tmp/test-cache');
    mgr.onMessagesAppended(400);
    expect(mgr.estimated).toBe(100);
  });

  it('onTokenUsage(5000) 后 estimated === 5000，pendingChars 清零', () => {
    const mgr = makeManager('/tmp/test-cache');
    mgr.onMessagesAppended(400); // pendingChars = 400
    mgr.onTokenUsage(5000);
    expect(mgr.estimated).toBe(5000);
    // pendingChars 已清零，再 append 0 chars estimated 仍为 5000
    mgr.onMessagesAppended(0);
    expect(mgr.estimated).toBe(5000);
  });

  it('onTokenUsage(5000) 后再 onMessagesAppended(800) → estimated === 5200', () => {
    const mgr = makeManager('/tmp/test-cache');
    mgr.onTokenUsage(5000);
    mgr.onMessagesAppended(800);
    expect(mgr.estimated).toBe(5200); // 5000 + ceil(800/4)
  });
});

// ─────────────────────────────────────────────
// F2：工具结果卸载
// ─────────────────────────────────────────────

describe('ContextManager - F2 offloadToolResults', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = join(tmpdir(), `ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('content > 8KB 的工具结果被卸载，content 变为预览格式，缓存文件存在且内容完整', async () => {
    const bigContent = 'x'.repeat(9000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', toolCallId: 'call-abc-1', toolName: 'read_file', content: bigContent, isError: false },
    ];
    const mgr = makeManager(cacheDir);
    await mgr.offloadToolResults(messages);

    // content 应以固定前缀开头
    expect(messages[1]!.content).toMatch(/^\[内容已卸载至文件:/);
    // content 应包含预览段落标记
    expect(messages[1]!.content).toContain('--- 内容预览（前 200 字符）---');
    // 缓存文件存在且内容完整
    const files = await import('node:fs/promises').then(fs => fs.readdir(cacheDir));
    expect(files.length).toBe(1);
    const fileContent = await readFile(join(cacheDir, files[0]!), 'utf8');
    expect(fileContent).toBe(bigContent);
  });

  it('content < 8KB 的消息不触发卸载，content 保持原值', async () => {
    const smallContent = 'x'.repeat(5000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', toolCallId: 'call-small', toolName: 'read_file', content: smallContent, isError: false },
    ];
    const mgr = makeManager(cacheDir);
    await mgr.offloadToolResults(messages);

    expect(messages[1]!.content).toBe(smallContent);
    // cacheDir 不存在或为空
    const exists = await import('node:fs/promises')
      .then(fs => fs.access(cacheDir).then(() => true).catch(() => false));
    // 要么目录不存在，要么为空
    if (exists) {
      const files = await import('node:fs/promises').then(fs => fs.readdir(cacheDir));
      expect(files.length).toBe(0);
    }
  });

  it('同一 turn 内 22KB+15KB 工具结果，轮级卸载后先卸载 22KB 那条，合计降至 15KB', async () => {
    const big1 = 'a'.repeat(22 * 1024);
    const big2 = 'b'.repeat(15 * 1024);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'tool', toolCallId: 'call-big1', toolName: 'tool1', content: big1, isError: false },
      { role: 'tool', toolCallId: 'call-big2', toolName: 'tool2', content: big2, isError: false },
    ];
    // 使用高于 22KB 的单条阈值，专门测试轮级卸载逻辑（排除单条卸载干扰）
    const mgr = new ContextManager(mockProvider, 'test-model', {
      contextWindow: 128000,
      offloadThresholdBytes: 100000,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 30000,
    });
    await mgr.offloadToolResults(messages);

    // big1（22KB）应被卸载（content 变为预览格式）
    expect(messages[1]!.content).toMatch(/^\[内容已卸载至文件:/);
    // big2（15KB）轮级卸载后合计降至 15KB ≤ 32KB，不再继续卸载
    expect(messages[2]!.content).toBe(big2);
  });

  it('不同 turn 各自写入独立文件，slug 来自各自 toolCallId', async () => {
    const content1 = 'x'.repeat(9000);
    const content2 = 'y'.repeat(9000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'tool', toolCallId: 'call-turn1', toolName: 'tool1', content: content1, isError: false },
      { role: 'user', content: 'q2' },
      { role: 'tool', toolCallId: 'call-turn2', toolName: 'tool2', content: content2, isError: false },
    ];
    const mgr = makeManager(cacheDir);
    await mgr.offloadToolResults(messages);

    const files = await import('node:fs/promises').then(fs => fs.readdir(cacheDir));
    expect(files.length).toBe(2);
    expect(files.some(f => f.includes('call-turn1'))).toBe(true);
    expect(files.some(f => f.includes('call-turn2'))).toBe(true);
  });

  it('写文件失败时 content 保持原值，不抛出异常，其他消息继续处理', async () => {
    const bigContent = 'x'.repeat(9000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'tool', toolCallId: 'call-fail', toolName: 'tool1', content: bigContent, isError: false },
    ];
    // 注入会 reject 的 _writeFile
    const mgr = new ContextManager(mockProvider, 'test-model', {
      contextWindow: 128000,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 30000,
      _writeFile: async () => { throw new Error('ENOSPC'); },
    });

    await expect(mgr.offloadToolResults(messages)).resolves.toBeUndefined();
    // content 保持原值
    expect(messages[1]!.content).toBe(bigContent);
  });

  it('N5：cacheDir 不存在时，offloadToolResults 调用后目录被自动创建', async () => {
    const bigContent = 'x'.repeat(9000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'tool', toolCallId: 'call-mkdir', toolName: 'tool1', content: bigContent, isError: false },
    ];
    const mgr = makeManager(cacheDir);

    // 确认目录尚不存在
    const fs = await import('node:fs/promises');
    const existsBefore = await fs.access(cacheDir).then(() => true).catch(() => false);
    expect(existsBefore).toBe(false);

    await mgr.offloadToolResults(messages);

    // 卸载后目录应已被自动创建
    const existsAfter = await fs.access(cacheDir).then(() => true).catch(() => false);
    expect(existsAfter).toBe(true);
  });
});

// ─────────────────────────────────────────────
// F3/F4/F5：LLM 摘要 + 边界消息 + 熔断
// ─────────────────────────────────────────────

type ProviderEvent = import('../../../src/providers/types.js').ProviderEvent;

function makeStreamProvider(events: ProviderEvent[]): ChatModelProvider {
  return {
    protocol: 'openai' as any,
    supportsExtendedThinking: false,
    stream: (_req: any) =>
      (async function* () {
        for (const e of events) yield e;
      })(),
  };
}

/** 构造 n 对 user+assistant 消息 */
function makeMessages(n: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', content: `user message ${i} `.repeat(20) });
    msgs.push({ role: 'assistant', content: `assistant reply ${i} `.repeat(20) });
  }
  return msgs;
}

describe('ContextManager - F3/F4/F5 compress', () => {
  const CONTEXT_WINDOW = 20000;
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `ctx-compress-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('estimated=6500（≤ 7000）时不触发摘要，返回 true', async () => {
    const streamSpy = vi.fn();
    const provider: ChatModelProvider = {
      protocol: 'openai' as any,
      supportsExtendedThinking: false,
      stream: streamSpy as any,
    };
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(6500);
    const result = await mgr.compress(makeMessages(3), new Set());
    expect(result).toBe(true);
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('estimated=7100（> 7000）触发摘要；消息头部替换、尾部保留、AC3/AC4/估算重置', async () => {
    let capturedRequest: any = null;
    const summaryText = '这是测试摘要内容';
    const provider: ChatModelProvider = {
      protocol: 'openai' as any,
      supportsExtendedThinking: false,
      stream: (req: any) => {
        capturedRequest = req;
        return (async function* () {
          yield { type: 'content.delta', delta: `<summary>${summaryText}</summary>` } as ProviderEvent;
          yield { type: 'response.complete' } as ProviderEvent;
        })();
      },
    };
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    const messages = makeMessages(8);
    const tailMsg = messages[messages.length - 1]!;
    const result = await mgr.compress(messages, new Set());

    expect(result).toBe(true);
    // AC3：toolChoice==='none'，tools 为空数组
    expect(capturedRequest.toolChoice).toBe('none');
    expect(capturedRequest.tools).toHaveLength(0);
    // AC4：messages[1] 是 assistant 边界消息，含 "[上下文已压缩]"
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.content).toContain('[上下文已压缩]');
    // 尾部保留区：原最后一条消息仍在
    expect(messages[messages.length - 1]).toStrictEqual(tailMsg);
    // 估算重置：lastKnownTotalPromptTokens=0，estimated = ceil(totalChars/4)
    const totalChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
    expect(mgr.estimated).toBe(Math.ceil(totalChars / 4));
  });

  it('stream 不含 <summary> 标签，compress 返回 false，circuitOpen 仍为 false', async () => {
    const provider = makeStreamProvider([
      { type: 'content.delta', delta: 'no summary tag here' },
      { type: 'response.complete' },
    ]);
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    const result = await mgr.compress(makeMessages(8), new Set());
    expect(result).toBe(false);
    expect(mgr.circuitOpen).toBe(false);
  });

  it('连续失败 3 次后 circuitOpen=true；自动调用不触发 stream，返回 true', async () => {
    const streamSpy = vi.fn().mockImplementation(() =>
      (async function* () {
        yield { type: 'content.delta', delta: 'no summary' } as ProviderEvent;
        yield { type: 'response.complete' } as ProviderEvent;
      })()
    );
    const provider: ChatModelProvider = {
      protocol: 'openai' as any,
      supportsExtendedThinking: false,
      stream: streamSpy as any,
    };
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    const messages = makeMessages(8);
    await mgr.compress(messages, new Set());
    await mgr.compress(messages, new Set());
    await mgr.compress(messages, new Set());
    expect(mgr.circuitOpen).toBe(true);

    streamSpy.mockClear();
    const result = await mgr.compress(messages, new Set());
    expect(result).toBe(true);
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('manual=true 失败不增加 consecutiveSummaryFailures，circuitOpen 保持 false', async () => {
    const provider = makeStreamProvider([
      { type: 'content.delta', delta: 'no summary' },
      { type: 'response.complete' },
    ]);
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    const messages = makeMessages(8);
    for (let i = 0; i < 5; i++) {
      await mgr.compress(messages, new Set(), true);
    }
    expect(mgr.circuitOpen).toBe(false);
  });

  it('protectedIndices 含 N-1（待摘要区边界），截断 N 使其不含受保护消息，返回 true', async () => {
    const provider: ChatModelProvider = {
      protocol: 'openai' as any,
      supportsExtendedThinking: false,
      stream: (_req: any) =>
        (async function* () {
          yield { type: 'content.delta', delta: '<summary>test</summary>' } as ProviderEvent;
          yield { type: 'response.complete' } as ProviderEvent;
        })(),
    };
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    // 使用 10 对消息，_calcRetainFrom 会返回 N=10（5 turn 窗口从末尾数 10 条）
    // protectedIndices = {3} 在待摘要区（3 < 10），应截断 N 到 3
    const messages = makeMessages(10); // 20 messages, N=10 from calcRetainFrom
    const protectedIndices = new Set([3]);
    const result = await mgr.compress(messages, protectedIndices, false);
    expect(result).toBe(true);
    // N 被截断到 3，重映射：i=3 >= 3 → 3-3+2=2，所以 protectedIndices = {2}
    expect(protectedIndices.has(3)).toBe(false);
    expect(protectedIndices.has(2)).toBe(true);
  });

  it('摘要成功后 protectedIndices 正确重映射（i>=N → i-N+2；i<N 被移除）', async () => {
    const provider: ChatModelProvider = {
      protocol: 'openai' as any,
      supportsExtendedThinking: false,
      stream: (_req: any) =>
        (async function* () {
          yield { type: 'content.delta', delta: '<summary>test</summary>' } as ProviderEvent;
          yield { type: 'response.complete' } as ProviderEvent;
        })(),
    };
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    const messages = makeMessages(8); // 16 messages
    // 在保留区（末尾附近）放一个受保护下标
    const protectedIndices = new Set([14]);
    await mgr.compress(messages, protectedIndices, false);
    // 原 index 14 应已被重映射（不再是 14）
    expect(protectedIndices.has(14)).toBe(false);
  });

  it('待摘要区 < 2 条，compress 返回 true 且不调用 stream', async () => {
    const streamSpy = vi.fn();
    const provider: ChatModelProvider = {
      protocol: 'openai' as any,
      supportsExtendedThinking: false,
      stream: streamSpy as any,
    };
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    // 只有 1 条消息 → 待摘要区 < 2
    const messages: ChatMessage[] = [{ role: 'user', content: 'only one' }];
    const result = await mgr.compress(messages, new Set());
    expect(result).toBe(true);
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('N3：AbortError 超时视为失败，consecutiveSummaryFailures 递增', async () => {
    const provider: ChatModelProvider = {
      protocol: 'openai' as any,
      supportsExtendedThinking: false,
      stream: (_req: any) =>
        (async function* () {
          throw new DOMException('The operation was aborted', 'AbortError');
        })(),
    };
    const mgr = new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: 5000,
    });
    mgr.onTokenUsage(7100);
    const result = await mgr.compress(makeMessages(8), new Set());
    expect(result).toBe(false);
    expect(mgr.circuitOpen).toBe(false); // 1 次，未到 3
  });
});
