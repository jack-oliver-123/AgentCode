import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '../../../src/config/schema.js';
import { createProvider } from '../../../src/providers/createProvider.js';
import { OpenAIProvider } from '../../../src/providers/openai/OpenAIProvider.js';
import type { ProviderEvent } from '../../../src/providers/types.js';
import { createDefaultToolRegistry } from '../../../src/tools/registry.js';
import { createMockSseServer } from '../../helpers/createMockSseServer.js';

describe('OpenAIProvider', () => {
  it('streams OpenAI chat completion chunks as provider events', async () => {
    const server = await createMockSseServer({
      chunks: [
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/custom/openai/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'Continue' },
          ],
          thinking: {
            enabled: false,
          },
        }),
      );

      expect(events).toEqual([
        { type: 'response.start' },
        { type: 'content.delta', delta: 'Hel' },
        { type: 'content.delta', delta: 'lo' },
        { type: 'response.complete', finishReason: 'stop' },
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
          { role: 'user', content: 'Continue' },
        ],
        stream: true,
        stream_options: { include_usage: true },
      });
    } finally {
      await server.close();
    }
  });

  it('maps tool declarations and tool choice to OpenAI-compatible request bodies', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });
      const tools = createDefaultToolRegistry().getProviderDeclarations();

      await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Read a file' }],
          thinking: { enabled: false },
          tools,
          toolChoice: 'auto',
        }),
      );

      expect(JSON.parse(server.requests[0]?.body ?? '{}')).toMatchObject({
        model: 'gpt-4.1',
        stream: true,
        tool_choice: 'auto',
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({
              name: 'read_file',
              parameters: expect.objectContaining({
                type: 'object',
              }),
            }),
          }),
        ]),
      });
    } finally {
      await server.close();
    }
  });

  it('maps tool continuation messages to OpenAI-compatible request bodies', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [
            { role: 'user', content: 'Read a file' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-read', name: 'read_file', argumentsText: '{"path":"README.md"}' }],
            },
            {
              role: 'tool',
              toolCallId: 'call-read',
              toolName: 'read_file',
              content: '{"ok":true}',
              isError: false,
            },
          ],
          thinking: { enabled: false },
          toolChoice: 'none',
        }),
      );

      expect(JSON.parse(server.requests[0]?.body ?? '{}')).toMatchObject({
        messages: [
          { role: 'user', content: 'Read a file' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-read',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call-read', content: '{"ok":true}' },
        ],
        tool_choice: 'none',
      });
    } finally {
      await server.close();
    }
  });

  it('omits tool declarations when tool choice disables tools', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'No tools' }],
          thinking: { enabled: false },
          tools: createDefaultToolRegistry().getProviderDeclarations(),
          toolChoice: 'none',
        }),
      );

      expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'No tools' }],
        stream: true,
        stream_options: { include_usage: true },
        tool_choice: 'none',
      });
    } finally {
      await server.close();
    }
  });

  it('assembles streamed OpenAI tool call argument fragments into a provider tool event', async () => {
    const server = await createMockSseServer({
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read-file","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Read README' }],
          thinking: { enabled: false },
          tools: createDefaultToolRegistry().getProviderDeclarations(),
          toolChoice: 'auto',
        }),
      );

      expect(events).toEqual([
        { type: 'response.start' },
        {
          type: 'tool.call',
          call: {
            id: 'call-read-file',
            name: 'read_file',
            argumentsText: '{"path":"README.md"}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ]);
    } finally {
      await server.close();
    }
  });

  it('reports all streamed tool calls when a provider emits multiple tool calls', async () => {
    const server = await createMockSseServer({
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}},{"index":1,"id":"call-search","function":{"name":"search_code","arguments":"{\\"query\\":\\"x\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Use tools' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toEqual([
        { type: 'response.start' },
        {
          type: 'tool.call',
          call: {
            id: 'call-read',
            name: 'read_file',
            argumentsText: '{"path":"README.md"}',
          },
        },
        {
          type: 'tool.call',
          call: {
            id: 'call-search',
            name: 'search_code',
            argumentsText: '{"query":"x"}',
          },
        },
        { type: 'response.complete', finishReason: 'tool_calls' },
      ]);
      expect(events.filter((event) => event.type === 'tool.call')).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('emits a protocol error for invalid streamed tool call fragments', async () => {
    const server = await createMockSseServer({
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read","function":{"name":"read_file","arguments":{}}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Use a tool' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            message: 'OpenAI-compatible provider returned invalid tool call arguments.',
            retryable: false,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a protocol error when streamed tool call fragments have invalid indexes', async () => {
    const server = await createMockSseServer({
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":"0","id":"call-read","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Use a tool' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            message: 'OpenAI-compatible provider returned an invalid tool call index.',
            retryable: false,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('treats [DONE] as completion when no finish_reason chunk arrives', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{"content":"Done"},"finish_reason":null}]}\n\n', 'data: [DONE]\n\n'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      await expect(
        collectProviderEvents(
          provider.stream({
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'Hello' }],
            thinking: { enabled: false },
          }),
        ),
      ).resolves.toEqual([
        { type: 'response.start' },
        { type: 'content.delta', delta: 'Done' },
        { type: 'response.complete' },
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a public error event for invalid JSON stream chunks', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {not-json}\n\n'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            retryable: false,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a public error event for non-2xx provider responses', async () => {
    const server = await createMockSseServer({
      status: 401,
      chunks: ['bad auth'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'auth_error',
            retryable: false,
            status: 401,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('preserves OpenAI SSE error payload details', async () => {
    const server = await createMockSseServer({
      chunks: [
        'event: error\n' +
          'data: {"error":{"message":"quota exhausted","type":"rate_limit_error","code":"insufficient_quota"}}\n\n',
      ],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'rate_limit',
            message: 'quota exhausted',
            retryable: true,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('maps OpenAI invalid_request_error SSE events to non-retryable provider errors', async () => {
    const server = await createMockSseServer({
      chunks: [
        'event: error\n' +
          'data: {"error":{"message":"invalid tools schema","type":"invalid_request_error","code":null}}\n\n',
      ],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'provider_error',
            message: 'invalid tools schema',
            retryable: false,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a protocol error when a 200 response is not an event stream', async () => {
    const server = await createMockSseServer({
      headers: {
        'content-type': 'application/json',
      },
      chunks: ['{"error":"not a stream"}'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            retryable: false,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a protocol error when the stream ends before a completion signal', async () => {
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'],
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        { type: 'content.delta', delta: 'partial' },
        {
          type: 'response.error',
          error: {
            code: 'protocol_error',
            retryable: false,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('emits a non-retryable cancellation error when aborted during streaming', async () => {
    const abortController = new AbortController();
    const server = await createMockSseServer({
      chunks: ['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'],
      end: false,
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
        }),
      });
      const iterator = provider
        .stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
          signal: abortController.signal,
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
            retryable: false,
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it('emits a retryable network error when the event stream stalls', async () => {
    const server = await createMockSseServer({
      chunks: [],
      end: false,
    });

    try {
      const provider = new OpenAIProvider({
        config: createOpenAIConfig({
          baseUrl: `${server.url}/v1`,
          request: {
            timeoutMs: 20,
            headers: {},
          },
        }),
      });

      const events = await collectProviderEvents(
        provider.stream({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'Hello' }],
          thinking: { enabled: false },
        }),
      );

      expect(events).toMatchObject([
        { type: 'response.start' },
        {
          type: 'response.error',
          error: {
            code: 'network_error',
            retryable: true,
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });
});

describe('createProvider', () => {
  it('creates an OpenAI provider for openai protocol config', () => {
    const provider = createProvider({
      config: createOpenAIConfig(),
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
      enabled: false,
    },
    request: {
      timeoutMs: 1000,
      headers: {},
    },
    ui: {
      showThinking: false,
    },
    ...overrides,
  };
}

async function collectProviderEvents(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collectedEvents: ProviderEvent[] = [];

  for await (const event of events) {
    collectedEvents.push(event);
  }

  return collectedEvents;
}
