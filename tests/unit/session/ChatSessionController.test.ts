import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../../src/config/schema.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../../../src/providers/types.js';
import { ChatSessionController, type ChatSessionControllerOptions } from '../../../src/session/ChatSessionController.js';
import type { ChatSessionState } from '../../../src/session/types.js';
import type { ToolDefinition, ToolExecutionContext, ToolRegistry } from '../../../src/tools/types.js';
import { FakeProvider } from '../../helpers/FakeProvider.js';

describe('ChatSessionController', () => {
  it('submits user text, streams assistant draft, and commits assistant only on completion', async () => {
    const provider = new FakeProvider([
      { type: 'response.start' },
      { type: 'content.delta', delta: 'Hel' },
      { type: 'content.delta', delta: 'lo' },
      { type: 'response.complete', finishReason: 'stop' }
    ]);
    const controller = createController(provider);

    const states = await collectStates(controller.submitUserText('Hi'));

    expect(states[0]).toMatchObject({
      status: 'streaming',
      messages: [{ role: 'user' }],
      draft: { visibleText: '', thinkingText: '' }
    });
    expect(states[1]?.draft?.visibleText).toBe('Hel');
    expect(states[2]?.draft?.visibleText).toBe('Hello');

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
            finishReason: 'stop'
          }
        }
      ]
    });
    expect(finalState?.draft).toBeUndefined();
    expect(provider.requests[0]).toMatchObject({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { enabled: false }
    });
  });

  it('sends only completed visible transcript on later turns', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'First answer' },
      { type: 'response.complete', finishReason: 'end_turn' }
    ]);
    const controller = createController(provider);

    await collectStates(controller.submitUserText('First question'));
    await collectStates(controller.submitUserText('Second question'));

    expect(provider.requests[1]?.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' }
    ]);
  });

  it('keeps thinking deltas in draft only and never commits them to transcript', async () => {
    const provider = new FakeProvider(
      [
        { type: 'thinking.delta', delta: 'hidden ' },
        { type: 'thinking.delta', delta: 'reasoning' },
        { type: 'content.delta', delta: 'visible answer' },
        { type: 'response.complete', finishReason: 'end_turn' }
      ],
      { protocol: 'anthropic', supportsExtendedThinking: true }
    );
    const controller = createController(provider, {
      protocol: 'anthropic',
      thinking: {
        enabled: true,
        budgetTokens: 1024
      }
    });

    const states = await collectStates(controller.submitUserText('Think'));

    expect(states[1]?.draft?.thinkingText).toBe('hidden ');
    expect(states[2]?.draft?.thinkingText).toBe('hidden reasoning');
    expect(states.at(-1)?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'visible answer' }]);
    expect(JSON.stringify(states.at(-1)?.messages)).not.toContain('hidden reasoning');
    expect(provider.requests[0]?.thinking).toEqual({ enabled: true, budgetTokens: 1024 });
  });

  it('omits tool choice when tool execution is not enabled', async () => {
    const provider = new FakeProvider([{ type: 'content.delta', delta: 'Plain answer' }, { type: 'response.complete', finishReason: 'stop' }]);
    const controller = createController(provider);

    await collectStates(controller.submitUserText('Plain question'));

    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(provider.requests[0]?.toolChoice).toBeUndefined();
  });

  it('fails explicitly when a provider emits a tool call before tool execution is enabled', async () => {
    const provider = new FakeProvider([
      {
        type: 'tool.call',
        call: {
          id: 'call-read-file',
          name: 'read_file',
          argumentsText: '{"path":"README.md"}'
        }
      },
      { type: 'response.complete', finishReason: 'tool_calls' }
    ]);
    const controller = createController(provider);

    const states = await collectStates(controller.submitUserText('Read README'));
    const finalState = states.at(-1);

    expect(finalState).toMatchObject({
      status: 'error',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Read README' }] }],
      lastError: {
        code: 'protocol_error',
        retryable: false
      }
    });
    expect(finalState?.messages).toHaveLength(1);
    expect(finalState?.draft).toBeUndefined();
  });

  it('executes one tool call and sends the redacted result to a second provider request', async () => {
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-read-file',
            name: 'test_tool',
            argumentsText: '{"value":"hello"}'
          }
        }
      ],
      [
        { type: 'content.delta', delta: 'Tool result received' },
        { type: 'response.complete', finishReason: 'stop' }
      ]
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    const states = await collectStates(controller.submitUserText('Use a tool'));
    const finalState = states.at(-1);

    expect(states.some((state) => state.draft?.activity.type === 'tool' && state.draft.activity.toolName === 'test_tool')).toBe(true);
    expect(finalState).toMatchObject({
      status: 'idle',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Use a tool' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Tool result received' }] }
      ]
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({
      tools: [
        {
          name: 'test_tool'
        }
      ],
      toolChoice: 'auto'
    });
    expect(provider.requests[1]).toMatchObject({
      toolChoice: 'none'
    });
    expect(provider.requests[1]?.tools).toBeUndefined();
    expect(provider.requests[1]?.messages.slice(-2)).toMatchObject([
      {
        role: 'assistant',
        toolCalls: [
          {
            id: 'call-read-file',
            name: 'test_tool',
            argumentsText: '{"value":"hello"}'
          }
        ]
      },
      {
        role: 'tool',
        toolCallId: 'call-read-file',
        toolName: 'test_tool',
        content: expect.stringContaining('"ok":true'),
        isError: false
      }
    ]);
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
            argumentsText: '{"value":"hello"}'
          }
        }
      ],
      [{ type: 'content.delta', delta: 'Done' }, { type: 'response.complete', finishReason: 'stop' }]
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    await collectStates(controller.submitUserText('Use a tool after text'));

    expect(provider.requests[1]?.messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: 'I will inspect the file first.',
      toolCalls: [
        {
          id: 'call-with-prefix'
        }
      ]
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
            argumentsText: '{}'
          }
        }
      ],
      [{ type: 'content.delta', delta: 'Handled unknown tool' }, { type: 'response.complete', finishReason: 'stop' }]
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    const states = await collectStates(controller.submitUserText('Use an unknown tool'));

    expect(states.some((state) => state.draft?.activity.type === 'tool' && state.draft.activity.toolName === 'tool')).toBe(true);
    expect(JSON.stringify(states)).not.toContain('argumentsText');
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
            argumentsText: '{"value":"hello"}'
          }
        }
      ],
      [{ type: 'thinking.delta', delta: 'second pass thought' }, { type: 'content.delta', delta: 'Final' }, { type: 'response.complete', finishReason: 'stop' }]
    ]);
    const controller = createController(
      provider,
      {
        protocol: 'anthropic',
        thinking: { enabled: true, budgetTokens: 1024 }
      },
      { toolRegistry: createTestToolRegistry() }
    );

    const states = await collectStates(controller.submitUserText('Think and use a tool'));

    expect(states.some((state) => state.draft?.activity.type === 'tool' && state.draft.thinkingText === 'first pass thought')).toBe(true);
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
            argumentsText: '{"value":"fail"}'
          }
        }
      ],
      [{ type: 'content.delta', delta: 'I saw the tool failure' }, { type: 'response.complete', finishReason: 'stop' }]
    ]);
    const controller = createController(provider, {}, { toolRegistry: createTestToolRegistry() });

    await collectStates(controller.submitUserText('Use a failing tool'));

    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      isError: true,
      content: expect.stringContaining('"ok":false')
    });
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain('tool failed');
    expect(controller.getState().messages.at(-1)?.parts[0]?.text).toBe('I saw the tool failure');
  });

  it('rejects a second provider tool call without executing another tool', async () => {
    const registry = createTestToolRegistry();
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-first',
            name: 'test_tool',
            argumentsText: '{"value":"hello"}'
          }
        }
      ],
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-second',
            name: 'test_tool',
            argumentsText: '{"value":"again"}'
          }
        }
      ]
    ]);
    const controller = createController(provider, {}, { toolRegistry: registry });

    const states = await collectStates(controller.submitUserText('Use two tools'));

    expect(states.at(-1)).toMatchObject({
      status: 'error',
      lastError: {
        code: 'protocol_error'
      }
    });
    expect(registry.executions).toEqual(['hello']);
  });

  it('discards assistant draft on provider error and keeps the user message', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'partial' },
      {
        type: 'response.error',
        error: {
          code: 'provider_error',
          message: 'provider failed',
          retryable: true
        }
      }
    ]);
    const controller = createController(provider);

    const states = await collectStates(controller.submitUserText('Question'));
    const finalState = states.at(-1);

    expect(finalState).toMatchObject({
      status: 'error',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Question' }] }],
      lastError: {
        code: 'provider_error',
        retryable: true
      }
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
            retryable: true
          }
        }
      ],
      [{ type: 'content.delta', delta: 'second answer' }, { type: 'response.complete', finishReason: 'stop' }]
    ]);
    const controller = createController(provider);

    await collectStates(controller.submitUserText('Failed question'));
    await collectStates(controller.submitUserText('Fresh question'));

    expect(provider.requests[1]?.messages).toEqual([
      { role: 'user', content: 'Failed question' },
      { role: 'user', content: 'Fresh question' }
    ]);
    expect(controller.getState().messages.map((message) => message.parts[0]?.text)).toEqual([
      'Failed question',
      'Fresh question',
      'second answer'
    ]);
  });

  it('prevents concurrent submissions while streaming', async () => {
    const provider = new FakeProvider([{ type: 'response.complete' }], { holdBeforeEvents: true });
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
        retryable: false
      }
    });
    expect(provider.requests).toHaveLength(0);

    provider.release();
    await firstTurn.next();
    await firstTurn.next();
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
        retryable: false
      }
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
          description: 'Value to echo.'
        }
      },
      required: ['value'],
      additionalProperties: false
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
          retryable: true
        }
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
            retryable: false
          },
          meta: {
            durationMs: 0,
            timedOut: false
          }
        };
      }

      return {
        ok: true,
        toolName: 'test_tool',
        data: {
          value: input.value,
          secret: context.secrets[0]
        },
        meta: {
          durationMs: 0,
          timedOut: false
        }
      };
    }
  };

  return {
    executions,
    list: () => [tool],
    get: (name: string) => (name === tool.name ? tool : undefined),
    getProviderDeclarations: () => [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }
    ]
  };
}

function createController(
  provider: ChatModelProvider,
  configOverrides: Partial<AgentConfig> = {},
  controllerOptions: Partial<Omit<ChatSessionControllerOptions, 'provider' | 'config' | 'createId' | 'now'>> = {}
): ChatSessionController {
  let idCounter = 0;
  return new ChatSessionController({
    provider,
    config: createConfig(configOverrides),
    createId: (prefix) => `${prefix}-${++idCounter}`,
    now: () => 1234,
    cwd: process.cwd(),
    ...controllerOptions
  });
}

function createConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    protocol: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test-session-secret',
    thinking: {
      enabled: false
    },
    request: {
      timeoutMs: 1000,
      headers: {}
    },
    ui: {
      showThinking: false
    },
    ...overrides
  };
}

async function collectStates(events: AsyncIterable<{ state: ChatSessionState }>): Promise<ChatSessionState[]> {
  const states: ChatSessionState[] = [];

  for await (const event of events) {
    states.push(event.state);
  }

  return states;
}
