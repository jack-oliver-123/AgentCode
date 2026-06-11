import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../../src/config/schema.js';
import { AnthropicProvider } from '../../../src/providers/anthropic/AnthropicProvider.js';
import { createProvider } from '../../../src/providers/createProvider.js';
import type { ProviderEvent } from '../../../src/providers/types.js';
import { createMockSseServer } from '../../helpers/createMockSseServer.js';

describe('AnthropicProvider', () => {
  it('streams Anthropic text deltas as provider content events', async () => {
    const server = await createMockSseServer({
      chunks: [
        'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]
    });

    try {
      const provider = new AnthropicProvider({
        config: createAnthropicConfig({
          baseUrl: `${server.url}/custom/anthropic/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'claude-opus-4-8',
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
        { type: 'response.complete', finishReason: 'end_turn' }
      ]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe('POST');
      expect(server.requests[0]?.url).toBe('/custom/anthropic/v1/messages');
      expect(server.requests[0]?.headers['x-api-key']).toBe('sk-test-anthropic-secret');
      expect(server.requests[0]?.headers['anthropic-version']).toBe('2023-06-01');
      expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({
        model: 'claude-opus-4-8',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'Continue' }
        ],
        stream: true,
        max_tokens: 4096
      });
    } finally {
      await server.close();
    }
  });

  it('sends extended thinking config and separates thinking deltas from visible content', async () => {
    const server = await createMockSseServer({
      chunks: [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden reasoning"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"visible"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]
    });

    try {
      const provider = new AnthropicProvider({
        config: createAnthropicConfig({
          baseUrl: `${server.url}/v1`,
          thinking: {
            enabled: true,
            budgetTokens: 2048
          }
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'Think then answer' }],
          thinking: {
            enabled: true,
            budgetTokens: 2048
          }
        })
      );

      expect(events).toEqual([
        { type: 'response.start' },
        { type: 'thinking.delta', delta: 'hidden reasoning' },
        { type: 'content.delta', delta: 'visible' },
        { type: 'response.complete', finishReason: 'end_turn' }
      ]);
      expect(JSON.parse(server.requests[0]?.body ?? '{}')).toMatchObject({
        thinking: {
          type: 'enabled',
          budget_tokens: 2048
        },
        max_tokens: 4096
      });
    } finally {
      await server.close();
    }
  });

  it('emits a protocol error when the stream ends before message_stop', async () => {
    const server = await createMockSseServer({
      chunks: ['event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n']
    });

    try {
      const provider = new AnthropicProvider({
        config: createAnthropicConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'claude-opus-4-8',
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

  it('maps structured SSE error events to retryable provider errors', async () => {
    const server = await createMockSseServer({
      chunks: [
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Anthropic is overloaded"}}\n\n'
      ]
    });

    try {
      const provider = new AnthropicProvider({
        config: createAnthropicConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false }
        })
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'provider_error',
            retryable: true
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });

  it('maps malformed SSE error payloads to protocol errors', async () => {
    const server = await createMockSseServer({
      chunks: ['event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n']
    });

    try {
      const provider = new AnthropicProvider({
        config: createAnthropicConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'claude-opus-4-8',
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

  it('emits a non-retryable cancellation error when aborted during streaming', async () => {
    const abortController = new AbortController();
    const server = await createMockSseServer({
      chunks: [
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'
      ],
      end: false
    });

    try {
      const provider = new AnthropicProvider({
        config: createAnthropicConfig({
          baseUrl: `${server.url}/v1`
        })
      });
      const iterator = provider
        .stream({
          model: 'claude-opus-4-8',
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

  it('emits a public error for invalid JSON stream events', async () => {
    const server = await createMockSseServer({
      chunks: ['event: content_block_delta\ndata: {not-json}\n\n']
    });

    try {
      const provider = new AnthropicProvider({
        config: createAnthropicConfig({
          baseUrl: `${server.url}/v1`
        })
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'claude-opus-4-8',
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
});

describe('createProvider', () => {
  it('creates an Anthropic provider for anthropic protocol config', () => {
    const provider = createProvider({
      config: createAnthropicConfig()
    });

    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.protocol).toBe('anthropic');
    expect(provider.supportsExtendedThinking).toBe(true);
  });
});

function createAnthropicConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    protocol: 'anthropic',
    model: 'claude-opus-4-8',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-test-anthropic-secret',
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
