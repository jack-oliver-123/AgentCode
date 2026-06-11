import type { AgentConfig } from '../../config/schema.js';
import { AgentCodeError, toPublicError } from '../../shared/errors.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../types.js';
import { createCancellationError, createProtocolError } from '../shared/errors.js';
import { joinEndpoint } from '../shared/endpoint.js';
import { fetchJsonStream, type FetchJsonOptions, type FetchTransportOptions } from '../shared/fetchTransport.js';
import { readNextSseEvent, readSseStream } from '../shared/sse.js';

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
    finish_reason?: unknown;
  }>;
}

export interface OpenAIProviderOptions {
  config: AgentConfig;
  fetch?: FetchTransportOptions['fetch'];
}

export class OpenAIProvider implements ChatModelProvider {
  readonly protocol = 'openai';
  readonly supportsExtendedThinking = false;

  private readonly config: AgentConfig;
  private readonly fetchImpl: FetchTransportOptions['fetch'];

  constructor(options: OpenAIProviderOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    try {
      yield { type: 'response.start' };

      const requestOptions: FetchJsonOptions = {
        url: joinEndpoint(this.config.baseUrl, '/chat/completions'),
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.request.headers
        },
        body: {
          model: request.model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          stream: true
        },
        ...(request.signal !== undefined ? { signal: request.signal } : {})
      };

      const transportOptions: FetchTransportOptions = {
        timeoutMs: this.config.request.timeoutMs,
        ...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {})
      };

      const stream = await fetchJsonStream(requestOptions, transportOptions);

      let finishReason: string | undefined;
      const streamTimeoutController = new AbortController();
      const sseIterator = readSseStream(stream, { signal: streamTimeoutController.signal })[Symbol.asyncIterator]();

      try {
        while (true) {
          const { done, value: sseEvent } = await readNextSseEvent(sseIterator, this.config.request.timeoutMs, () => {
            streamTimeoutController.abort();
          });

          if (done === true) {
            throw createProtocolError('OpenAI-compatible provider stream ended before a completion signal.');
          }

          if (sseEvent.data === '[DONE]') {
            yield createCompleteEvent(finishReason);
            return;
          }

          if (sseEvent.event === 'error') {
            yield {
              type: 'response.error',
              error: toPublicError(createProtocolError('OpenAI-compatible provider returned an SSE error event.'))
            };
            return;
          }

          const chunk = parseOpenAIChunk(sseEvent.data);
          const choice = chunk.choices?.[0];
          const content = choice?.delta?.content;

          if (typeof content === 'string' && content.length > 0) {
            yield {
              type: 'content.delta',
              delta: content
            };
          }

          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason;
            yield createCompleteEvent(finishReason);
            return;
          }
        }
      } finally {
        await sseIterator.return?.();
      }
    } catch (error) {
      yield {
        type: 'response.error',
        error: toPublicError(isAbortError(error) ? createCancellationError() : error)
      };
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function parseOpenAIChunk(data: string): OpenAIChatCompletionChunk {
  try {
    const parsed = JSON.parse(data) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      throw createProtocolError('OpenAI-compatible provider returned a non-object stream chunk.');
    }

    return parsed as OpenAIChatCompletionChunk;
  } catch (error) {
    if (error instanceof AgentCodeError) {
      throw error;
    }

    throw createProtocolError('OpenAI-compatible provider returned invalid JSON in the stream.');
  }
}

function createCompleteEvent(finishReason: string | undefined): ProviderEvent {
  if (finishReason === undefined) {
    return { type: 'response.complete' };
  }

  return {
    type: 'response.complete',
    finishReason
  };
}
