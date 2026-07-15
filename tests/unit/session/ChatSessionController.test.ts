import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../../src/config/schema.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../../../src/providers/types.js';
import {
  ChatSessionController,
  type ChatSessionControllerOptions,
} from '../../../src/session/ChatSessionController.js';
import type { ChatSessionState } from '../../../src/session/types.js';
import type { ToolDefinition, ToolExecutionContext, ToolRegistry } from '../../../src/tools/types.js';
import { FakeProvider } from '../../helpers/FakeProvider.js';

describe('ChatSessionController', () => {
  it('submits user text, streams assistant draft, and commits assistant only on completion', async () => {
    const provider = new FakeProvider([
      { type: 'response.start' },
      { type: 'content.delta', delta: 'Hel' },
      { type: 'content.delta', delta: 'lo' },
      { type: 'response.complete', finishReason: 'stop' },
    ]);
    const controller = createController(provider);

    const states = await collectStates(controller.submitUserText('Hi'));

    // 第一个状态: streaming 开始
    expect(states[0]).toMatchObject({
      status: 'streaming',
      messages: [{ role: 'user' }],
      draft: { visibleText: '', thinkingText: '' },
    });

    // 中间有 iteration.start 触发的重置，然后有 text deltas
    const draftTexts = states.map((s) => s.draft?.visibleText).filter((t) => t !== undefined && t !== '');
    expect(draftTexts).toContain('Hel');
    expect(draftTexts).toContain('Hello');

    const finalState = states.at(-1);
    expect(finalState).toMatchObject({
      status: 'idle',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hello' }],
          meta: {
            model: 'test-model',
            provider: 'openai',
          },
        },
      ],
    });
    expect(finalState?.draft).toBeUndefined();
    expect(provider.requests[0]).toMatchObject({
      messages: [{ role: 'user', content: 'Hi' }],
    });
  });

  it('sends only completed visible transcript on later turns', async () => {
    const provider = new FakeProvider([
      [
        { type: 'content.delta', delta: 'First answer' },
        { type: 'response.complete', finishReason: 'end_turn' },
      ],
      [
        { type: 'content.delta', delta: 'Second answer' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider);

    await collectStates(controller.submitUserText('First question'));
    await collectStates(controller.submitUserText('Second question'));

    expect(provider.requests[1]?.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ]);
  });

  it('keeps thinking deltas in draft only and never commits them to transcript', async () => {
    const provider = new FakeProvider(
      [
        { type: 'thinking.delta', delta: 'hidden ' },
        { type: 'thinking.delta', delta: 'reasoning' },
        { type: 'content.delta', delta: 'visible answer' },
        { type: 'response.complete', finishReason: 'end_turn' },
      ],
      { protocol: 'anthropic', supportsExtendedThinking: true },
    );
    const controller = createController(provider, {
      protocol: 'anthropic',
      thinking: {
        enabled: true,
        budgetTokens: 1024,
      },
    });

    const states = await collectStates(controller.submitUserText('Think'));

    // thinking deltas 出现在 draft 中
    const thinkingStates = states.filter((s) => s.draft?.thinkingText && s.draft.thinkingText.length > 0);
    expect(thinkingStates.some((s) => s.draft?.thinkingText === 'hidden ')).toBe(true);
    expect(thinkingStates.some((s) => s.draft?.thinkingText === 'hidden reasoning')).toBe(true);

    // 最终 commit 的消息不含 thinking
    expect(states.at(-1)?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'visible answer' }]);
    expect(JSON.stringify(states.at(-1)?.messages)).not.toContain('hidden reasoning');
  });

  it('permissionMode=plan 从 plan 状态启动并仅向 provider 暴露 read 工具', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'Plan answer' },
      { type: 'response.complete', finishReason: 'stop' },
    ]);
    const controller = createController(provider, { permissionMode: 'plan' }, {
      permissionMode: 'plan',
      toolRegistry: createTestToolRegistry(),
    });

    expect(controller.getState().mode).toBe('plan');
    await collectStates(controller.submitUserText('Inspect the project'));

    expect(provider.requests[0]?.tools).toEqual([{ name: 'test_tool', description: expect.any(String), inputSchema: expect.any(Object) }]);
  });

  it('Tab 和 /do 在 plan/full 间切换并恢复 full 权限策略', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'Done' },
      { type: 'response.complete', finishReason: 'stop' },
    ]);
    const controller = createController(provider, { permissionMode: 'plan' }, { permissionMode: 'plan' });

    expect(controller.toggleMode().state.mode).toBe('full');
    expect(controller.toggleMode().state.mode).toBe('plan');

    const states = await collectStates(controller.submitUserText('/do implement it'));
    expect(states[0]?.mode).toBe('full');
    expect(provider.requests[0]?.messages.at(-1)).toMatchObject({ role: 'user', content: 'implement it' });
  });

  it('omits tool choice when tool execution is not enabled', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'Plain answer' },
      { type: 'response.complete', finishReason: 'stop' },
    ]);
    const controller = createController(provider);

    await collectStates(controller.submitUserText('Plain question'));

    // 无 toolRegistry 时 tools 为空数组（来自 empty registry）
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  it('executes one tool call and sends the result to a second provider request', async () => {
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-read-file',
            name: 'test_tool',
            argumentsText: '{"value":"hello"}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        { type: 'content.delta', delta: 'Tool result received' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    const states = await collectStates(controller.submitUserText('Use a tool'));
    const finalState = states.at(-1);

    // 验证有 tool activity 状态
    expect(
      states.some((state) => state.draft?.activity.type === 'tool' && state.draft.activity.toolName === 'test_tool'),
    ).toBe(true);

    expect(finalState?.status).toBe('idle');
    expect(finalState?.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Use a tool' }] });
    // assistant message 包含 tool_use part + text part
    const assistantParts = finalState?.messages[1]?.parts ?? [];
    expect(assistantParts.some((p) => p.type === 'tool_use' && p.toolName === 'test_tool')).toBe(true);
    expect(assistantParts.at(-1)).toMatchObject({ type: 'text', text: 'Tool result received' });

    // Agent Loop 发起了两次 provider 请求
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({
      tools: [{ name: 'test_tool' }],
      toolChoice: 'auto',
    });
    // 第二次请求包含工具调用和结果
    expect(provider.requests[1]?.messages.slice(-2)).toMatchObject([
      {
        role: 'assistant',
        toolCalls: [
          {
            id: 'call-read-file',
            name: 'test_tool',
            argumentsText: '{"value":"hello"}',
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-read-file',
        toolName: 'test_tool',
        isError: false,
      },
    ]);
    // 验证 secret 被 redacted
    expect(JSON.stringify(provider.requests[1])).not.toContain('sk-test-session-secret');
  });

  it('preserves assistant text emitted before a tool call in the provider continuation', async () => {
    const provider = new FakeProvider([
      [
        { type: 'content.delta', delta: 'I will inspect the file first.' },
        {
          type: 'tool.call',
          call: {
            id: 'call-with-prefix',
            name: 'test_tool',
            argumentsText: '{"value":"hello"}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        { type: 'content.delta', delta: 'Done' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    await collectStates(controller.submitUserText('Use a tool after text'));

    expect(provider.requests[1]?.messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: 'I will inspect the file first.',
      toolCalls: [{ id: 'call-with-prefix' }],
    });
  });

  it('uses a generic activity label for unknown provider tool names', async () => {
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-unknown',
            name: 'unknown {"argumentsText":"sk-test-session-secret"}',
            argumentsText: '{}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        { type: 'content.delta', delta: 'Handled unknown tool' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    const states = await collectStates(controller.submitUserText('Use an unknown tool'));

    expect(
      states.some((state) => state.draft?.activity.type === 'tool' && state.draft.activity.toolName === 'tool'),
    ).toBe(true);
    expect(JSON.stringify(states)).not.toContain('sk-test-session-secret');
  });

  it('clears pre-tool thinking before streaming the final answer', async () => {
    const provider = new FakeProvider([
      [
        { type: 'thinking.delta', delta: 'first pass thought' },
        {
          type: 'tool.call',
          call: {
            id: 'call-thinking-tool',
            name: 'test_tool',
            argumentsText: '{"value":"hello"}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        { type: 'thinking.delta', delta: 'second pass thought' },
        { type: 'content.delta', delta: 'Final' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(
      provider,
      {
        protocol: 'anthropic',
        thinking: { enabled: true, budgetTokens: 1024 },
      },
      { toolRegistry: createTestToolRegistry() },
    );

    const states = await collectStates(controller.submitUserText('Think and use a tool'));

    // 在第二轮迭代开始时 thinkingText 被重置
    const finalStreamingState = states.find((state) => state.draft?.visibleText === 'Final');
    expect(finalStreamingState?.draft?.thinkingText).toBe('second pass thought');
    expect(finalStreamingState?.draft?.thinkingText).not.toContain('first pass thought');
  });

  it('feeds failed tool execution results back to the provider', async () => {
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-failing-tool',
            name: 'test_tool',
            argumentsText: '{"value":"fail"}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        { type: 'content.delta', delta: 'I saw the tool failure' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    await collectStates(controller.submitUserText('Use a failing tool'));

    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      isError: true,
      content: expect.stringContaining('tool failed'),
    });
    const lastMsg = controller.getState().messages.at(-1);
    const textPart = lastMsg?.parts.find((p) => p.type === 'text');
    expect(textPart?.type === 'text' ? textPart.text : undefined).toBe('I saw the tool failure');
  });

  it('handles multi-step tool calls autonomously (Agent Loop)', async () => {
    const registry = createTestToolRegistry();
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: { id: 'call-first', name: 'test_tool', argumentsText: '{"value":"hello"}' },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool.call',
          call: { id: 'call-second', name: 'test_tool', argumentsText: '{"value":"world"}' },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        { type: 'content.delta', delta: 'Both tools executed' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider, {}, { toolRegistry: registry });

    const states = await collectStates(controller.submitUserText('Use two tools'));

    const finalState = states.at(-1);
    expect(finalState?.status).toBe('idle');
    expect(finalState?.messages[0]).toMatchObject({ role: 'user' });
    // assistant message 包含 2 个 tool_use parts + text part
    const assistantParts = finalState?.messages[1]?.parts ?? [];
    expect(assistantParts.filter((p) => p.type === 'tool_use')).toHaveLength(2);
    expect(assistantParts.at(-1)).toMatchObject({ type: 'text', text: 'Both tools executed' });
    expect(registry.executions).toEqual(['hello', 'world']);
    expect(provider.requests).toHaveLength(3);
  });

  it('discards assistant draft on provider error and keeps the user message', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'partial' },
      {
        type: 'response.error',
        error: {
          code: 'provider_error',
          message: 'provider failed',
          retryable: false,
        },
      },
    ]);
    const controller = createController(provider);

    const states = await collectStates(controller.submitUserText('Question'));
    const finalState = states.at(-1);

    expect(finalState).toMatchObject({
      status: 'error',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Question' }] }],
      lastError: {
        code: 'provider_error',
        retryable: false,
      },
    });
    expect(finalState?.draft).toBeUndefined();
    expect(JSON.stringify(finalState?.messages)).not.toContain('partial');
  });

  it('includes failed user turns in later provider context without committing partial assistant text', async () => {
    const provider = new SequenceProvider([
      [
        { type: 'content.delta', delta: 'partial' },
        {
          type: 'response.error',
          error: {
            code: 'provider_error',
            message: 'failed',
            retryable: false,
          },
        },
      ],
      [
        { type: 'content.delta', delta: 'second answer' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider);

    await collectStates(controller.submitUserText('Failed question'));
    await collectStates(controller.submitUserText('Fresh question'));

    expect(provider.requests[1]?.messages).toEqual([
      { role: 'user', content: 'Failed question' },
      { role: 'user', content: 'Fresh question' },
    ]);
    expect(
      controller.getState().messages.map((message) => {
        const textPart = message.parts.find((p) => p.type === 'text');
        return textPart?.type === 'text' ? textPart.text : undefined;
      }),
    ).toEqual(['Failed question', 'Fresh question', 'second answer']);
  });

  it('prevents concurrent submissions while streaming', async () => {
    const provider = new FakeProvider([[{ type: 'response.complete' }]], { holdBeforeEvents: true });
    const controller = createController(provider);
    const firstTurn = controller.submitUserText('First')[Symbol.asyncIterator]();

    const firstState = await firstTurn.next();
    expect(firstState.value?.state.status).toBe('streaming');

    const concurrentStates = await collectStates(controller.submitUserText('Second'));
    expect(concurrentStates).toHaveLength(1);
    expect(concurrentStates[0]).toMatchObject({
      status: 'streaming',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'First' }] }],
      lastError: {
        code: 'provider_error',
        retryable: false,
      },
    });
    expect(provider.requests).toHaveLength(0);

    provider.release();
    // Drain remaining events
    let done = false;
    while (!done) {
      const result = await firstTurn.next();
      done = result.done ?? false;
    }
  });

  it('turns provider exceptions into public errors without committing the draft', async () => {
    const provider = new ThrowingProvider();
    const controller = createController(provider);

    const states = await collectStates(controller.submitUserText('Question'));
    const finalState = states.at(-1);

    expect(finalState).toMatchObject({
      status: 'error',
      messages: [{ role: 'user' }],
      lastError: {
        code: 'unknown_error',
        retryable: false,
      },
    });
    expect(finalState?.draft).toBeUndefined();
  });
});

class SequenceProvider implements ChatModelProvider {
  readonly protocol = 'openai';
  readonly supportsExtendedThinking = false;
  readonly requests: ProviderRequest[] = [];
  private index = 0;

  constructor(private readonly eventSequences: ProviderEvent[][]) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    const events = this.eventSequences[this.index] ?? [];
    this.index += 1;

    for (const event of events) {
      yield event;
    }
  }
}

class ThrowingProvider extends FakeProvider {
  constructor() {
    super([]);
  }

  override async *stream(): AsyncIterable<ProviderEvent> {
    throw new Error('boom');
  }
}

interface TestToolRegistry extends ToolRegistry {
  executions: string[];
}

function createTestToolRegistry(): TestToolRegistry {
  const executions: string[] = [];
  const tool: ToolDefinition<{ value: string }> = {
    name: 'test_tool',
    description: 'Test tool for session controller tests.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          type: 'string',
          description: 'Value to echo.',
        },
      },
      required: ['value'],
      additionalProperties: false,
    },
    validate(input: unknown) {
      if (typeof input === 'object' && input !== null && 'value' in input && typeof input.value === 'string') {
        return { ok: true, value: { value: input.value } };
      }

      return {
        ok: false,
        error: {
          code: 'invalid_arguments',
          message: 'value is required',
          retryable: true,
        },
      };
    },
    async execute(input: { value: string }, context: ToolExecutionContext) {
      executions.push(input.value);

      if (input.value === 'fail') {
        return {
          ok: false,
          toolName: 'test_tool',
          error: {
            code: 'tool_internal_error',
            message: 'tool failed',
            retryable: false,
          },
          meta: {
            durationMs: 0,
            timedOut: false,
          },
        };
      }

      return {
        ok: true,
        toolName: 'test_tool',
        data: {
          value: input.value,
          secret: context.secrets[0],
        },
        meta: {
          durationMs: 0,
          timedOut: false,
        },
      };
    },
  };

  return {
    executions,
    list: () => [tool],
    get: (name: string) => (name === tool.name ? tool : undefined),
    getProviderDeclarations: () => [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    ],
    filterByRisk: (allowedRisks) => {
      const allowed = new Set(allowedRisks);
      if (allowed.has(tool.risk)) {
        return {
          executions,
          list: () => [tool],
          get: (name: string) => (name === tool.name ? tool : undefined),
          getProviderDeclarations: () => [
            { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
          ],
          filterByRisk: () => createTestToolRegistry(),
        } as TestToolRegistry;
      }
      return {
        executions: [],
        list: () => [],
        get: () => undefined,
        getProviderDeclarations: () => [],
        filterByRisk: () =>
          ({
            executions: [],
            list: () => [],
            get: () => undefined,
            getProviderDeclarations: () => [],
            filterByRisk: () => ({}) as any,
          }) as any,
      } as any;
    },
  };
}

function createController(
  provider: ChatModelProvider,
  configOverrides: Partial<AgentConfig> = {},
  controllerOptions: Partial<Omit<ChatSessionControllerOptions, 'provider' | 'config' | 'createId' | 'now'>> = {},
): ChatSessionController {
  let idCounter = 0;
  return new ChatSessionController({
    provider,
    config: createConfig(configOverrides),
    createId: (prefix) => `${prefix}-${++idCounter}`,
    now: () => 1234,
    cwd: process.cwd(),
    buildSystemPrompt: () => ({ system: '', reminder: '' }),
    permissionMode: 'yolo',
    ...controllerOptions,
  });
}

function createConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    protocol: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test-session-secret',
    thinking: {
      enabled: false,
    },
    request: {
      timeoutMs: 1000,
      headers: {},
    },
    ui: {
      showThinking: false,
    },
    permissionMode: 'normal',
    ...overrides,
  };
}

async function collectStates(events: AsyncIterable<{ state: ChatSessionState }>): Promise<ChatSessionState[]> {
  const states: ChatSessionState[] = [];

  for await (const event of events) {
    states.push(event.state);
  }

  return states;
}

// ─────────────────────────────────────────────
// T5：ContextManager 集成先行测试
// ─────────────────────────────────────────────

describe('ChatSessionController - ContextManager 集成', () => {
  it('token.usage 事件触发 contextManager.onTokenUsage(totalPromptTokens)', async () => {
    const onTokenUsageCalls: number[] = [];
    const mockContextManager = createContextManagerMock({
      onTokenUsage: (totalPromptTokens) => {
        onTokenUsageCalls.push(totalPromptTokens);
      },
    });

    const provider = new FakeProvider([
      { type: 'response.start' },
      { type: 'response.usage', usage: { inputTokens: 1234, outputTokens: 0 } },
      { type: 'content.delta', delta: 'Hi' },
      { type: 'response.complete' },
    ]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    await collectStates(controller.submitUserText('test'));
    expect(onTokenUsageCalls).toContain(1234);
  });

  it('completeTurn 将完整工具 turn 的同一批 Provider 消息交给 ContextManager', async () => {
    const appendedCalls: unknown[][] = [];
    const mockContextManager = createContextManagerMock({
      onMessagesAppended: (messages) => {
        appendedCalls.push(messages as unknown[]);
      },
    });
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-complete-turn',
            name: 'test_tool',
            argumentsText: '{"value":"complete"}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ],
      [
        { type: 'content.delta', delta: 'Reply' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const controller = createController(provider, {}, {
      contextManager: mockContextManager,
      toolRegistry: createTestToolRegistry(),
    });

    await collectStates(controller.submitUserText('Hello'));

    expect(appendedCalls).toHaveLength(1);
    expect(appendedCalls[0]).toMatchObject([
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        toolCalls: [{ id: 'call-complete-turn', name: 'test_tool' }],
      },
      {
        role: 'tool',
        toolCallId: 'call-complete-turn',
        toolName: 'test_tool',
      },
      { role: 'assistant', content: 'Reply' },
    ]);
    expectProviderContextUsesSameMessages(controller, appendedCalls[0] ?? []);
  });

  it('failTurn 将实际追加的 user Provider 消息交给 ContextManager', async () => {
    const appendedCalls: unknown[][] = [];
    const mockContextManager = createContextManagerMock({
      onMessagesAppended: (messages) => {
        appendedCalls.push(messages as unknown[]);
      },
    });

    const provider = new FakeProvider([
      { type: 'response.error', error: { code: 'provider_error', message: 'fail', retryable: false } },
    ]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    await collectStates(controller.submitUserText('Hello'));

    expect(appendedCalls).toEqual([[{ role: 'user', content: 'Hello' }]]);
    expectProviderContextUsesSameMessages(controller, appendedCalls[0] ?? []);
  });

  it('正常 turn 每轮按 offload -> compact(auto) -> AgentLoop 执行，并传入此前用户原文', async () => {
    const callOrder: string[] = [];
    const compactCalls: CompactionRequestForTest[] = [];
    const mockContextManager = createContextManagerMock({
      offloadToolResults: async () => {
        callOrder.push('offload');
      },
      compact: async (_messages, request) => {
        callOrder.push('compact');
        compactCalls.push(request);
        return { outcome: 'skipped', reason: 'below_threshold', attempts: 0 };
      },
    });

    const provider = new FakeProvider([
      [
        { type: 'content.delta', delta: 'First reply' },
        { type: 'response.complete' },
      ],
      [
        { type: 'content.delta', delta: 'Second reply' },
        { type: 'response.complete' },
      ],
      [
        { type: 'content.delta', delta: 'Third reply' },
        { type: 'response.complete' },
      ],
    ]);
    const originalStream = provider.stream.bind(provider);
    (provider as any).stream = async function* (req: any) {
      callOrder.push('agentloop');
      yield* originalStream(req);
    };

    const controller = createController(provider, {}, { contextManager: mockContextManager });
    await collectStates(controller.submitUserText('First question'));
    await collectStates(controller.submitUserText('Second question'));
    await collectStates(controller.submitUserText('Third question'));

    expect(callOrder).toEqual([
      'offload', 'compact', 'agentloop',
      'offload', 'compact', 'agentloop',
      'offload', 'compact', 'agentloop',
    ]);
    expect(compactCalls).toEqual([
      { trigger: 'auto', originalUserMessages: ['First question'] },
      { trigger: 'auto', originalUserMessages: ['First question', 'Second question'] },
      { trigger: 'auto', originalUserMessages: ['First question', 'Second question', 'Third question'] },
    ]);
  });

  it('/compact 在任意水位都按 offload -> compact(manual) 执行且不进入 transcript', async () => {
    const callOrder: string[] = [];
    const compactCalls: CompactionRequestForTest[] = [];
    const mockContextManager = createContextManagerMock({
      offloadToolResults: async () => {
        callOrder.push('offload');
      },
      compact: async (_messages, request) => {
        callOrder.push('compact');
        compactCalls.push(request);
        return { outcome: 'compacted', level: 'normal', attempts: 1 };
      },
    });

    const provider = new FakeProvider([]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    const states = await collectStates(controller.submitUserText('/compact'));

    expect(callOrder).toEqual(['offload', 'compact']);
    expect(compactCalls).toEqual([{ trigger: 'manual', originalUserMessages: [] }]);
    expect(states.at(-1)).toMatchObject({ messages: [], notice: '上下文已压缩' });
    expect(provider.requests).toHaveLength(0);
  });

  it.each(['offload', 'compact'] as const)(
    '/compact 捕获 %s 异常、恢复非忙碌状态并返回失败 notice',
    async (failingDependency) => {
      let appendedCallCount = 0;
      const mockContextManager = createContextManagerMock({
        onMessagesAppended: () => {
          appendedCallCount++;
        },
        offloadToolResults: async () => {
          if (failingDependency === 'offload') {
            throw new Error('offload failed');
          }
        },
        compact: async () => {
          if (failingDependency === 'compact') {
            throw new Error('compact failed');
          }
          return { outcome: 'compacted', level: 'normal', attempts: 1 };
        },
      });
      const provider = new FakeProvider([]);
      const controller = createController(provider, {}, { contextManager: mockContextManager });

      const states = await collectStates(controller.submitUserText('/compact'));

      expect(states.at(-1)).toMatchObject({
        status: 'idle',
        messages: [],
        notice: '上下文压缩失败，请稍后重试',
      });
      expect(states.at(-1)?.draft).toBeUndefined();
      expect(provider.requests).toHaveLength(0);
      expect(appendedCallCount).toBe(0);
    },
  );

  it('/compact 压缩期间进入忙碌状态并拒绝并发普通提交', async () => {
    const compactStarted = createDeferred<void>();
    const compactResult = createDeferred<unknown>();
    let appendedCallCount = 0;
    const mockContextManager = createContextManagerMock({
      onMessagesAppended: () => {
        appendedCallCount++;
      },
      compact: async () => {
        compactStarted.resolve();
        return compactResult.promise;
      },
    });
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'must not run' },
      { type: 'response.complete' },
    ]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    const manualIterator = controller.submitUserText('/compact')[Symbol.asyncIterator]();
    const firstEventPromise = manualIterator.next();
    const firstOutcome = await Promise.race([
      firstEventPromise.then((event) => ({ kind: 'event' as const, event })),
      compactStarted.promise.then(() => ({ kind: 'compact_started' as const })),
    ]);

    if (firstOutcome.kind === 'compact_started') {
      compactResult.resolve({ outcome: 'compacted', level: 'normal', attempts: 1 });
      await firstEventPromise;
      throw new Error('/compact must publish a busy state before awaiting ContextManager');
    }

    expect(firstOutcome.event.value?.state).toMatchObject({
      status: 'streaming',
      messages: [],
    });
    expect(firstOutcome.event.value?.state.draft).toBeUndefined();

    const finalEventPromise = manualIterator.next();
    await compactStarted.promise;
    const blockedStates = await collectStates(controller.submitUserText('concurrent message'));

    expect(blockedStates).toHaveLength(1);
    expect(blockedStates[0]).toMatchObject({
      status: 'streaming',
      messages: [],
      lastError: {
        code: 'provider_error',
        retryable: false,
      },
    });
    expect(provider.requests).toHaveLength(0);
    expect(appendedCallCount).toBe(0);

    compactResult.resolve({ outcome: 'compacted', level: 'normal', attempts: 1 });
    const finalEvent = await finalEventPromise;

    expect(finalEvent.value?.state).toMatchObject({
      status: 'idle',
      messages: [],
      notice: '上下文已压缩',
    });
    expect(finalEvent.value?.state.lastError).toBeUndefined();
    expect(controller.getState().lastError).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
    expect(appendedCallCount).toBe(0);
    expect((await manualIterator.next()).done).toBe(true);
  });

  it.each([
    { label: 'success', rejects: false, notice: '上下文已压缩' },
    { label: 'dependency reject', rejects: true, notice: '上下文压缩失败，请稍后重试' },
  ] as const)(
    '/compact $label 后恢复进入命令前的 error 状态与原始 lastError',
    async ({ rejects, notice }) => {
      const compactStarted = createDeferred<void>();
      const compactResult = createDeferred<unknown>();
      let appendedCallCount = 0;
      const mockContextManager = createContextManagerMock({
        onMessagesAppended: () => {
          appendedCallCount++;
        },
        compact: async (_messages, request) => {
          if (request.trigger === 'auto') {
            return { outcome: 'skipped', reason: 'below_threshold', attempts: 0 };
          }
          compactStarted.resolve();
          return compactResult.promise;
        },
      });
      const provider = new FakeProvider([
        {
          type: 'response.error',
          error: {
            code: 'provider_error',
            message: 'original turn failed',
            retryable: false,
          },
        },
      ]);
      const controller = createController(provider, {}, { contextManager: mockContextManager });
      await collectStates(controller.submitUserText('failed turn'));
      const previousState = controller.getState();

      expect(previousState).toMatchObject({
        status: 'error',
        lastError: {
          code: 'provider_error',
          message: 'original turn failed',
          retryable: false,
        },
      });
      expect(appendedCallCount).toBe(1);

      const manualIterator = controller.submitUserText('/compact')[Symbol.asyncIterator]();
      const busyEvent = await manualIterator.next();
      expect(busyEvent.value?.state).toMatchObject({
        status: 'streaming',
        lastError: previousState.lastError,
      });

      const finalEventPromise = manualIterator.next();
      await compactStarted.promise;
      await collectStates(controller.submitUserText('blocked while compacting'));
      if (rejects) {
        compactResult.reject(new Error('manual compact failed'));
      } else {
        compactResult.resolve({ outcome: 'compacted', level: 'normal', attempts: 1 });
      }
      const finalEvent = await finalEventPromise;

      expect(finalEvent.value?.state.status).toBe('error');
      expect(finalEvent.value?.state.lastError).toEqual(previousState.lastError);
      expect(finalEvent.value?.state.notice).toBe(notice);
      expect(controller.getState().status).toBe('error');
      expect(controller.getState().lastError).toEqual(previousState.lastError);
      expect(provider.requests).toHaveLength(1);
      expect(appendedCallCount).toBe(1);
      expect((await manualIterator.next()).done).toBe(true);
    },
  );

  it('/compact 首个 busy event 后提前 return 会恢复原 error 状态且不执行命令依赖', async () => {
    let offloadCallCount = 0;
    let compactCallCount = 0;
    let appendedCallCount = 0;
    const mockContextManager = createContextManagerMock({
      onMessagesAppended: () => {
        appendedCallCount++;
      },
      offloadToolResults: async () => {
        offloadCallCount++;
      },
      compact: async () => {
        compactCallCount++;
        return { outcome: 'skipped', reason: 'below_threshold', attempts: 0 };
      },
    });
    const provider = new FakeProvider([
      {
        type: 'response.error',
        error: {
          code: 'provider_error',
          message: 'keep this error',
          retryable: false,
        },
      },
    ]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    await collectStates(controller.submitUserText('failed turn'));
    const previousState = controller.getState();
    const previousOffloadCalls = offloadCallCount;
    const previousCompactCalls = compactCallCount;
    const previousAppendedCalls = appendedCallCount;

    const manualIterator = controller.submitUserText('/compact')[Symbol.asyncIterator]();
    const busyEvent = await manualIterator.next();
    expect(busyEvent.value?.state.status).toBe('streaming');

    await manualIterator.return?.(undefined);

    expect(controller.getState().status).toBe('error');
    expect(controller.getState().lastError).toEqual(previousState.lastError);
    expect(controller.getState().messages).toEqual(previousState.messages);
    expect(offloadCallCount).toBe(previousOffloadCalls);
    expect(compactCallCount).toBe(previousCompactCalls);
    expect(appendedCallCount).toBe(previousAppendedCalls);
    expect(provider.requests).toHaveLength(1);
  });

  it.each([
    {
      label: 'compacted',
      result: { outcome: 'compacted', level: 'normal', attempts: 1 },
      notice: '上下文已压缩',
    },
    {
      label: 'emergency_fallback',
      result: { outcome: 'emergency_fallback', level: 'emergency', attempts: 5 },
      notice: '上下文已紧急压缩，摘要失败后已使用机械兜底',
    },
    {
      label: 'no_history',
      result: { outcome: 'skipped', reason: 'no_history', attempts: 0 },
      notice: '没有可压缩的历史',
    },
    {
      label: 'failed',
      result: { outcome: 'failed', level: 'normal', attempts: 1 },
      notice: '上下文压缩失败，请稍后重试',
    },
  ] as const)('/compact 将 $label 映射为精确中文 notice', async ({ result, notice }) => {
    const mockContextManager = createContextManagerMock({
      compact: async () => result,
    });

    const provider = new FakeProvider([]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    const states = await collectStates(controller.submitUserText('/compact'));

    expect(states.at(-1)?.notice).toBe(notice);
  });

  it('/compress 作为普通 user 文本进入 UI 和 Provider，且不触发 manual compact', async () => {
    const compactCalls: CompactionRequestForTest[] = [];
    const mockContextManager = createContextManagerMock({
      compact: async (_messages, request) => {
        compactCalls.push(request);
        return { outcome: 'skipped', reason: 'below_threshold', attempts: 0 };
      },
    });

    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'ordinary reply' },
      { type: 'response.complete' },
    ]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    const states = await collectStates(controller.submitUserText('/compress'));

    expect(compactCalls).toEqual([{ trigger: 'auto', originalUserMessages: ['/compress'] }]);
    expect(provider.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: '/compress' });
    expect(states.at(-1)?.messages[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: '/compress' }],
    });
  });

  it('loop.failed 的上下文过长 notice 建议使用 /compact', async () => {
    const mockContextManager = createContextManagerMock();

    const provider = new FakeProvider([
      { type: 'response.error', error: { code: 'provider_error', message: 'context length exceeded', retryable: false } },
    ]);
    const controller = createController(provider, {}, { contextManager: mockContextManager });
    const states = await collectStates(controller.submitUserText('test'));
    expect(states.at(-1)?.notice).toBe('上下文过长，请使用 /compact 压缩后继续');
  });
});

interface CompactionRequestForTest {
  trigger: 'auto' | 'manual';
  originalUserMessages: readonly string[];
}

interface ContextManagerMockOptions {
  onTokenUsage?: (totalPromptTokens: number) => void;
  onMessagesAppended?: (messages: readonly unknown[]) => void;
  offloadToolResults?: (messages: unknown[]) => Promise<void>;
  compact?: (messages: unknown[], request: CompactionRequestForTest) => Promise<unknown>;
}

function createContextManagerMock(options: ContextManagerMockOptions = {}): any {
  return {
    onTokenUsage: options.onTokenUsage ?? (() => {}),
    onMessagesAppended: options.onMessagesAppended ?? (() => {}),
    offloadToolResults: options.offloadToolResults ?? (async () => {}),
    compact: options.compact ?? (async () => ({ outcome: 'skipped', reason: 'below_threshold', attempts: 0 })),
    get estimated() {
      throw new Error('Controller must not read ContextManager.estimated');
    },
    get circuitOpen() {
      throw new Error('Controller must not read ContextManager.circuitOpen');
    },
    get contextWindow() {
      throw new Error('Controller must not read ContextManager.contextWindow');
    },
  };
}

function expectProviderContextUsesSameMessages(
  controller: ChatSessionController,
  appendedMessages: readonly unknown[],
): void {
  const providerContext = (controller as unknown as { providerContext: readonly unknown[] }).providerContext;
  expect(providerContext).toHaveLength(appendedMessages.length);
  for (const [index, message] of appendedMessages.entries()) {
    expect(providerContext[index]).toBe(message);
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise(value as T | PromiseLike<T>);
    },
    reject: (reason) => {
      rejectPromise(reason);
    },
  };
}
