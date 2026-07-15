import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../../src/config/schema.js';
import { ContextManager } from '../../../src/context/ContextManager.js';
import { USER_MESSAGES_PLACEHOLDER } from '../../../src/context/compaction.js';
import { AnthropicProvider } from '../../../src/providers/anthropic/AnthropicProvider.js';
import { OpenAIProvider } from '../../../src/providers/openai/OpenAIProvider.js';
import type { ChatModelProvider, ChatMessage, ProviderEvent, ProviderRequest } from '../../../src/providers/types.js';

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
    const files = await import('node:fs/promises').then((fs) => fs.readdir(cacheDir));
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
    const exists = await import('node:fs/promises').then((fs) =>
      fs
        .access(cacheDir)
        .then(() => true)
        .catch(() => false),
    );
    // 要么目录不存在，要么为空
    if (exists) {
      const files = await import('node:fs/promises').then((fs) => fs.readdir(cacheDir));
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

    const files = await import('node:fs/promises').then((fs) => fs.readdir(cacheDir));
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes('call-turn1'))).toBe(true);
    expect(files.some((f) => f.includes('call-turn2'))).toBe(true);
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
      _writeFile: async () => {
        throw new Error('ENOSPC');
      },
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
    const existsBefore = await fs
      .access(cacheDir)
      .then(() => true)
      .catch(() => false);
    expect(existsBefore).toBe(false);

    await mgr.offloadToolResults(messages);

    // 卸载后目录应已被自动创建
    const existsAfter = await fs
      .access(cacheDir)
      .then(() => true)
      .catch(() => false);
    expect(existsAfter).toBe(true);
  });
});

// ─────────────────────────────────────────────
// F3-F6/F9：统一 compact、九段摘要、降级重试与熔断
// ─────────────────────────────────────────────

const VALID_SUMMARY_RESPONSE = [
  '<analysis>',
  '按时间顺序整理错误、当前工作和下一步。',
  '</analysis>',
  '<summary>',
  '## 1. 主要请求和意图',
  '请求',
  '',
  '## 2. 关键技术概念',
  '概念',
  '',
  '## 3. 文件和代码段',
  '文件',
  '',
  '## 4. 错误和修复',
  '错误',
  '',
  '## 5. 问题解决过程',
  '过程',
  '',
  '## 6. 所有用户消息',
  USER_MESSAGES_PLACEHOLDER,
  '',
  '## 7. 待办任务',
  '待办',
  '',
  '## 8. 当前工作',
  '这是最详细的当前工作。',
  '',
  '## 9. 可能的下一步',
  '下一步',
  '</summary>',
].join('\n');

function streamEvents(events: readonly ProviderEvent[]): AsyncIterable<ProviderEvent> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function validSummaryStream(): AsyncIterable<ProviderEvent> {
  return streamEvents([{ type: 'content.delta', delta: VALID_SUMMARY_RESPONSE }, { type: 'response.complete' }]);
}

function makeStreamProvider(stream: ChatModelProvider['stream']): ChatModelProvider {
  return {
    protocol: 'openai',
    supportsExtendedThinking: false,
    stream,
  };
}

/** 构造 n 个完整 user turn。 */
function makeMessages(n: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < n; index++) {
    messages.push({ role: 'user', content: `turn user ${index}` });
    messages.push({ role: 'assistant', content: `turn assistant ${index}` });
  }
  return messages;
}

function makeOpenAIConfig(): AgentConfig {
  return {
    protocol: 'openai',
    model: 'gpt-4.1',
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'test-key',
    thinking: { enabled: false },
    request: { timeoutMs: 1000, headers: {} },
    ui: { showThinking: false },
    permissionMode: 'normal',
  };
}

function makeAnthropicConfig(): AgentConfig {
  return {
    ...makeOpenAIConfig(),
    protocol: 'anthropic',
    model: 'claude-opus-4-8',
    baseUrl: 'https://api.anthropic.test/v1',
  };
}

function makeOpenAISummaryResponse(): Response {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: VALID_SUMMARY_RESPONSE }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeAnthropicSummaryResponse(): Response {
  const chunks = [
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: VALID_SUMMARY_RESPONSE },
    })}\n\n`,
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('ContextManager - F3-F6/F9 compact', () => {
  const CONTEXT_WINDOW = 20_000;
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `ctx-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCompactManager(
    provider: ChatModelProvider,
    options: { timeoutMs?: number; forceMargin?: number; emergencyMargin?: number } = {},
  ): ContextManager {
    return new ContextManager(provider, 'test-model', {
      contextWindow: CONTEXT_WINDOW,
      offloadThresholdBytes: 8192,
      turnOffloadThresholdBytes: 32768,
      cacheDir,
      timeoutMs: options.timeoutMs ?? 5000,
      ...(options.forceMargin === undefined ? {} : { forceMargin: options.forceMargin }),
      ...(options.emergencyMargin === undefined ? {} : { emergencyMargin: options.emergencyMargin }),
    });
  }

  it.each([
    [13_000, 2_000],
    [14_000, 2_000],
    [5_000, 5_000],
    [5_000, -1],
    [Number.NaN, 0],
  ])('拒绝非法水位 forceMargin=%s emergencyMargin=%s', (forceMargin, emergencyMargin) => {
    expect(() =>
      makeCompactManager(mockProvider, {
        forceMargin,
        emergencyMargin,
      }),
    ).toThrow(RangeError);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, 4_294_967_296])(
    '拒绝非法 timeoutMs=%s',
    (timeoutMs) => {
      expect(() => makeCompactManager(mockProvider, { timeoutMs })).toThrow(RangeError);
    },
  );

  it('auto 位于 normal 严格边界时返回 below_threshold 且不调用 Provider', async () => {
    const stream = vi.fn<ChatModelProvider['stream']>();
    const manager = makeCompactManager(makeStreamProvider(stream));
    manager.onTokenUsage(7_000);

    await expect(
      manager.compact(makeMessages(8), { trigger: 'auto', originalUserMessages: ['原始需求'] }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'below_threshold', attempts: 0 });
    expect(stream).not.toHaveBeenCalled();
  });

  it('manual 在低水位仍按 normal 成功压缩，并使用九节两阶段单次请求', async () => {
    let capturedRequest: ProviderRequest | undefined;
    const provider = makeStreamProvider((request) => {
      capturedRequest = request;
      return validSummaryStream();
    });
    const manager = makeCompactManager(provider);
    const messages = makeMessages(8);
    const originalTail = messages.slice(6);
    const originalUserMessages = ['  原始需求  ', '第二条'];

    await expect(manager.compact(messages, { trigger: 'manual', originalUserMessages })).resolves.toEqual({
      outcome: 'compacted',
      level: 'normal',
      attempts: 1,
    });

    expect(capturedRequest).toMatchObject({
      model: 'test-model',
      tools: [],
      toolChoice: 'none',
      thinking: { enabled: false },
    });
    const prompt = [
      capturedRequest?.system ?? '',
      ...(capturedRequest?.messages.map((message) => message.content) ?? []),
    ].join('\n');
    expect(prompt).toContain('<analysis>');
    expect(prompt).toContain('<summary>');
    expect(prompt.match(/## [1-9]\. /g)).toHaveLength(9);
    expect(prompt.match(/\{\{ALL_USER_MESSAGES_VERBATIM\}\}/g)).toHaveLength(1);
    expect(prompt).toContain('第 8 节必须最详细');
    expect(messages[0]).toMatchObject({ role: 'user' });
    expect(messages[0]!.content).toContain('<user_message index="1" length="8">\n  原始需求  \n</user_message>');
    expect(messages[0]!.content).not.toContain('<analysis>');
    expect(messages[1]).toMatchObject({ role: 'assistant' });
    expect(messages[1]!.content).toContain('[上下文已压缩]');
    expect(messages.slice(2)).toEqual(originalTail);
    const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    expect(manager.estimated).toBe(Math.ceil(totalChars / 4));
  });

  it.each([
    [7_001, 'normal'],
    [15_000, 'normal'],
    [15_001, 'force'],
    [18_000, 'force'],
    [18_001, 'emergency'],
  ] as const)('estimated=%s 选择 %s 档位', async (estimated, level) => {
    const manager = makeCompactManager(makeStreamProvider(() => validSummaryStream()));
    manager.onTokenUsage(estimated);

    const result = await manager.compact(makeMessages(8), {
      trigger: 'auto',
      originalUserMessages: ['原始需求'],
    });

    expect(result).toEqual({ outcome: 'compacted', level, attempts: 1 });
  });

  it('完整请求后连续裁剪当前 turns 的 10%、10%、10%、20%，并为每次请求创建独立 signal', async () => {
    const requests: ProviderRequest[] = [];
    const provider = makeStreamProvider((request) => {
      requests.push(request);
      const call = requests.length;
      if (call === 2) {
        return (async function* () {
          throw new Error('input too long');
        })();
      }
      if (call < 5) {
        const messages = [
          'context length exceeded',
          '',
          'maximum allowed prompt tokens exceeded',
          'token limit exceeded',
        ];
        return streamEvents([
          {
            type: 'response.error',
            error: { code: 'provider_error', message: messages[call - 1]!, retryable: false },
          },
        ]);
      }
      return validSummaryStream();
    });
    const manager = makeCompactManager(provider);

    const result = await manager.compact(makeMessages(25), {
      trigger: 'manual',
      originalUserMessages: ['所有原始用户消息'],
    });

    expect(result).toEqual({ outcome: 'compacted', level: 'normal', attempts: 5 });
    expect(requests).toHaveLength(5);
    expect(
      requests.map((request) => request.messages.filter((message) => message.content.startsWith('turn user ')).length),
    ).toEqual([20, 18, 16, 14, 11]);
    const signals = requests.map((request) => request.signal);
    expect(signals.every((signal) => signal !== undefined)).toBe(true);
    expect(new Set(signals).size).toBe(5);
  });

  it('真实 OpenAIProvider 将 HTTP 400 context_length_exceeded 穿透为五次降级并最终成功', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (fetchMock.mock.calls.length <= 4) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'context_length_exceeded',
              type: 'invalid_request_error',
              message: 'maximum context length exceeded; private user content must not leak',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return makeOpenAISummaryResponse();
    });
    const provider = new OpenAIProvider({ config: makeOpenAIConfig(), fetch: fetchMock });
    const manager = makeCompactManager(provider);

    await expect(
      manager.compact(makeMessages(25), {
        trigger: 'manual',
        originalUserMessages: ['所有原始用户消息'],
      }),
    ).resolves.toEqual({ outcome: 'compacted', level: 'normal', attempts: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('真实 AnthropicProvider 将 HTTP 413 request_too_large 穿透为五次降级并最终成功', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (fetchMock.mock.calls.length <= 4) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'request_too_large',
              message: 'Request exceeds the maximum allowed number of bytes',
            },
          }),
          { status: 413, headers: { 'content-type': 'application/json' } },
        );
      }
      return makeAnthropicSummaryResponse();
    });
    const provider = new AnthropicProvider({ config: makeAnthropicConfig(), fetch: fetchMock });
    const manager = makeCompactManager(provider);

    await expect(
      manager.compact(makeMessages(25), {
        trigger: 'manual',
        originalUserMessages: ['所有原始用户消息'],
      }),
    ).resolves.toEqual({ outcome: 'compacted', level: 'normal', attempts: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('认证 token 错误不是长度错误，只调用一次且不改写上下文', async () => {
    const stream = vi.fn((_request: ProviderRequest) =>
      streamEvents([
        {
          type: 'response.error',
          error: {
            code: 'auth_error',
            message: 'authentication token invalid: context length exceeded',
            retryable: false,
          },
        },
      ]),
    );
    const manager = makeCompactManager(makeStreamProvider(stream));
    const messages = makeMessages(8);
    const snapshot = structuredClone(messages);

    await expect(manager.compact(messages, { trigger: 'manual', originalUserMessages: ['原始需求'] })).resolves.toEqual(
      { outcome: 'failed', level: 'normal', attempts: 1 },
    );
    expect(stream).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(snapshot);
  });

  it.each([
    ['rate_limit', 'maximum tokens per minute exceeded'],
    ['network_error', 'context window exceeded'],
    ['provider_error', 'maximum output tokens exceeded'],
    ['protocol_error', 'input is too long'],
    ['config_error', 'prompt too long'],
  ] as const)('%s 的“%s”不是输入长度错误，只调用一次', async (code, message) => {
    const stream = vi.fn((_request: ProviderRequest) =>
      streamEvents([
        {
          type: 'response.error',
          error: { code, message, retryable: false },
        },
      ]),
    );
    const manager = makeCompactManager(makeStreamProvider(stream));

    await expect(
      manager.compact(makeMessages(8), { trigger: 'manual', originalUserMessages: ['原始需求'] }),
    ).resolves.toEqual({ outcome: 'failed', level: 'normal', attempts: 1 });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['provider_error', 'context_length_exceeded'],
    ['provider_error', "This model's maximum context length is 4096 tokens, including 1000 completion tokens."],
    ['provider_error', 'prompt is too long'],
    ['provider_error', 'input is too long'],
    ['provider_error', 'max prompt tokens exceeded'],
    ['unknown_error', 'token limit exceeded'],
  ] as const)('%s 的真实输入长度变体“%s”会降级重试', async (code, message) => {
    const stream = vi.fn((_request: ProviderRequest) =>
      stream.mock.calls.length === 1
        ? streamEvents([
            {
              type: 'response.error',
              error: { code, message, retryable: false },
            },
          ])
        : validSummaryStream(),
    );
    const manager = makeCompactManager(makeStreamProvider(stream));

    await expect(
      manager.compact(makeMessages(8), { trigger: 'manual', originalUserMessages: ['原始需求'] }),
    ).resolves.toEqual({ outcome: 'compacted', level: 'normal', attempts: 2 });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['stream 未 complete', [{ type: 'content.delta', delta: VALID_SUMMARY_RESPONSE }]],
    [
      '九节 summary 非法',
      [
        { type: 'content.delta', delta: '<analysis>草稿</analysis><summary>非法</summary>' },
        { type: 'response.complete' },
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, readonly ProviderEvent[]]>)(
    '%s 是普通 failure 且保持原子性',
    async (_name, events) => {
      const manager = makeCompactManager(makeStreamProvider(() => streamEvents(events)));
      manager.onTokenUsage(7_001);
      const messages = makeMessages(8);
      const snapshot = structuredClone(messages);
      const estimate = manager.estimated;

      await expect(
        manager.compact(messages, { trigger: 'manual', originalUserMessages: ['原始需求'] }),
      ).resolves.toEqual({ outcome: 'failed', level: 'normal', attempts: 1 });
      expect(messages).toEqual(snapshot);
      expect(manager.estimated).toBe(estimate);
    },
  );

  it('裁剪后没有 turn 时停止，不发送只有摘要指令的请求', async () => {
    const stream = vi.fn((_request: ProviderRequest) =>
      streamEvents([
        {
          type: 'response.error',
          error: { code: 'provider_error', message: 'prompt too long', retryable: false },
        },
      ]),
    );
    const manager = makeCompactManager(makeStreamProvider(stream));

    await expect(
      manager.compact(makeMessages(6), { trigger: 'manual', originalUserMessages: ['原始需求'] }),
    ).resolves.toEqual({ outcome: 'failed', level: 'normal', attempts: 1 });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('没有较早完整 turn 时返回 no_history 且不调用 Provider', async () => {
    const stream = vi.fn<ChatModelProvider['stream']>();
    const manager = makeCompactManager(makeStreamProvider(stream));

    await expect(
      manager.compact(makeMessages(5), { trigger: 'manual', originalUserMessages: ['原始需求'] }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'no_history', attempts: 0 });
    expect(stream).not.toHaveBeenCalled();
  });

  it('孤立工具结果在调用 Provider 前失败并保持上下文不变', async () => {
    const stream = vi.fn<ChatModelProvider['stream']>();
    const manager = makeCompactManager(makeStreamProvider(stream));
    const messages = makeMessages(8);
    messages.splice(1, 0, {
      role: 'tool',
      toolCallId: 'orphan',
      toolName: 'read_file',
      content: 'result',
      isError: false,
    });
    const snapshot = structuredClone(messages);

    await expect(manager.compact(messages, { trigger: 'manual', originalUserMessages: ['原始需求'] })).resolves.toEqual(
      { outcome: 'failed', level: 'normal', attempts: 0 },
    );
    expect(stream).not.toHaveBeenCalled();
    expect(messages).toEqual(snapshot);
  });

  it('一整组五次重试最终失败只增加一次自动失败计数', async () => {
    const stream = vi.fn((_request: ProviderRequest) =>
      streamEvents([
        {
          type: 'response.error',
          error: { code: 'provider_error', message: 'context window exceeded', retryable: false },
        },
      ]),
    );
    const manager = makeCompactManager(makeStreamProvider(stream));
    manager.onTokenUsage(7_001);
    const messages = makeMessages(25);

    for (let compactCall = 0; compactCall < 2; compactCall++) {
      const result = await manager.compact(messages, {
        trigger: 'auto',
        originalUserMessages: ['原始需求'],
      });
      expect(result).toEqual({ outcome: 'failed', level: 'normal', attempts: 5 });
      expect(manager.circuitOpen).toBe(false);
    }
    await manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] });

    expect(manager.circuitOpen).toBe(true);
    expect(stream).toHaveBeenCalledTimes(15);
  });

  it('auto normal 受熔断阻止，force/emergency 和 manual 绕过熔断', async () => {
    const stream = vi.fn((_request: ProviderRequest) =>
      streamEvents([{ type: 'content.delta', delta: '<summary>非法</summary>' }, { type: 'response.complete' }]),
    );
    const manager = makeCompactManager(makeStreamProvider(stream));
    const messages = makeMessages(8);
    manager.onTokenUsage(7_001);
    for (let index = 0; index < 3; index++) {
      await manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] });
    }
    expect(manager.circuitOpen).toBe(true);

    const callsBeforeSkip = stream.mock.calls.length;
    await expect(manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] })).resolves.toEqual({
      outcome: 'skipped',
      reason: 'circuit_open',
      level: 'normal',
      attempts: 0,
    });
    expect(stream).toHaveBeenCalledTimes(callsBeforeSkip);

    manager.onTokenUsage(15_001);
    await expect(manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] })).resolves.toEqual({
      outcome: 'failed',
      level: 'force',
      attempts: 1,
    });

    manager.onTokenUsage(18_001);
    await expect(manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] })).resolves.toEqual({
      outcome: 'failed',
      level: 'emergency',
      attempts: 1,
    });

    manager.onTokenUsage(7_001);
    await expect(manager.compact(messages, { trigger: 'manual', originalUserMessages: ['原始需求'] })).resolves.toEqual(
      { outcome: 'failed', level: 'normal', attempts: 1 },
    );
  });

  it('manual 最终失败不增加熔断计数，任意摘要成功会清零已有失败', async () => {
    let returnValidSummary = false;
    const provider = makeStreamProvider(() =>
      returnValidSummary
        ? validSummaryStream()
        : streamEvents([{ type: 'content.delta', delta: '<summary>非法</summary>' }, { type: 'response.complete' }]),
    );
    const manager = makeCompactManager(provider);
    const messages = makeMessages(8);
    manager.onTokenUsage(7_001);

    for (let index = 0; index < 4; index++) {
      await manager.compact(messages, { trigger: 'manual', originalUserMessages: ['原始需求'] });
    }
    expect(manager.circuitOpen).toBe(false);

    await manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] });
    await manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] });
    returnValidSummary = true;
    await manager.compact(messages, { trigger: 'manual', originalUserMessages: ['原始需求'] });
    returnValidSummary = false;
    messages.push(...makeMessages(2));
    manager.onTokenUsage(7_001);
    await manager.compact(messages, { trigger: 'auto', originalUserMessages: ['原始需求'] });

    expect(manager.circuitOpen).toBe(false);
  });
});
