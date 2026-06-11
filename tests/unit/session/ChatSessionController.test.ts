import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../../src/config/schema.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../../../src/providers/types.js';
import { ChatSessionController } from '../../../src/session/ChatSessionController.js';
import type { ChatSessionState } from '../../../src/session/types.js';
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

function createController(provider: ChatModelProvider, configOverrides: Partial<AgentConfig> = {}): ChatSessionController {
  let idCounter = 0;
  return new ChatSessionController({
    provider,
    config: createConfig(configOverrides),
    createId: (prefix) => `${prefix}-${++idCounter}`,
    now: () => 1234
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
