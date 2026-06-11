import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../../src/config/schema.js';
import { createProvider } from '../../../src/providers/createProvider.js';
import { OpenAIProvider } from '../../../src/providers/openai/OpenAIProvider.js';
import type { ProviderEvent } from '../../../src/providers/types.js';
import { createMockSseServer } from '../../helpers/createMockSseServer.js';

describe('OpenAIProvider', () => {
  it('streams OpenAI chat completion chunks as provider events', async () => {
    const server = await createMockSseServer({
      chunks: [
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ]
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/custom/openai/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'Continue' }
          ],
          thinking: {
            enabled: false
          }
        })
      );

      expect(events).toEqual([
        { type: 'response.start' },
        { type: 'content.delta', delta: 'Hel' },
        { type: 'content.delta', delta: 'lo' },
        { type: 'response.complete', finishReason: 'stop' }
      ]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe('POST');
      expect(server.requests[0]?.url).toBe('/custom/openai/v1/chat/completions');
      expect(server.requests[0]?.headers.authorization).toBe('Bearer sk-test-openai-secret');
      expect(server.requests[0]?.headers.accept).toBe('text/event-stream');
      expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({
        model: 'gpt-4.1',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'Continue' }
        ],
        stream: true
      });
    } finally {
      await server.close();
    }
  });

  it('treats [DONE] as completion when no finish_reason chunk arrives', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{"content":"Done"},"finish_reason":null}]}\n\n', 'data: [DONE]\n\n']
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      await expect(
        collectProviderEvents(
          provider.stream({
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'Hello' }],
            thinking: { enabled: false }
          })
        )
      ).resolves.toEqual([{ type: 'response.start' }, { type: 'content.delta', delta: 'Done' }, { type: 'response.complete' }]);
    } finally {
      await server.close();
    }
  });

  it('emits a public error event for invalid JSON stream chunks', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {not-json}\n\n']
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false }
        })
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            retryable: false
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a public error event for non-2xx provider responses', async () => {
    const server = await createMockSseServer({
      status: 401,
      chunks: ['bad auth']
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false }
        })
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'auth_error',
            retryable: false,
            status: 401
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a protocol error when a 200 response is not an event stream', async () => {
    const server = await createMockSseServer({
      headers: {
        'content-type': 'application/json'
      },
      chunks: ['{"error":"not a stream"}']
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false }
        })
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            retryable: false
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a protocol error when the stream ends before a completion signal', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n']
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false }
        })
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        { type: 'content.delta', delta: 'partial' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            retryable: false
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a non-retryable cancellation error when aborted during streaming', async () => {
    const abortController = new AbortController();
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'],
      end: false
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`
        })
      });
      const iterator = provider
        .stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
          signal: abortController.signal
        })
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'response.start' } });
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'content.delta', delta: 'partial' } });

      abortController.abort();

      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          type: 'response.error',
          error: {
            code: 'network_error',
            retryable: false
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it('emits a retryable network error when the event stream stalls', async () => {
    const server = await createMockSseServer({
      chunks: [],
      end: false
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
          request: {
            timeoutMs: 20,
            headers: {}
          }
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false }
        })
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'network_error',
            retryable: true
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });
});

describe('createProvider', () => {
  it('creates an OpenAI provider for openai protocol config', () => {
    const provider = createProvider({
      config: createOpenAIConfig()
    });

    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.protocol).toBe('openai');
    expect(provider.supportsExtendedThinking).toBe(false);
  });
});

function createOpenAIConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    protocol: 'openai',
    model: 'gpt-4.1',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-openai-secret',
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

async function collectProviderEvents(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collectedEvents: ProviderEvent[] = [];

  for await (const event of events) {
    collectedEvents.push(event);
  }

  return collectedEvents;
}
