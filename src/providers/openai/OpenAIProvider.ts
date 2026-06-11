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
              error: toPublicError(parseOpenAIStreamError(sseEvent.data))
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

function parseOpenAIStreamError(data: string): AgentCodeError {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) {
      return createProtocolError('OpenAI-compatible provider returned an invalid SSE error event.');
    }

    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) {
      return createProtocolError('OpenAI-compatible provider returned an invalid SSE error payload.');
    }

    const message = (error as { message?: unknown }).message;
    if (typeof message !== 'string') {
      return createProtocolError('OpenAI-compatible provider returned an invalid SSE error payload.');
    }

    const type = (error as { type?: unknown }).type;
    const code = (error as { code?: unknown }).code;
    return createOpenAIError(typeof type === 'string' ? type : undefined, typeof code === 'string' ? code : undefined, message);
  } catch {
    return createProtocolError('OpenAI-compatible provider returned invalid JSON in an SSE error event.');
  }
}

function createOpenAIError(type: string | undefined, code: string | undefined, message: string): AgentCodeError {
  const errorName = code ?? type ?? '';

  if (isOpenAIAuthError(errorName)) {
    return new AgentCodeError({
      code: 'auth_error',
      message,
      retryable: false
    });
  }

  if (isOpenAIRateLimitError(errorName)) {
    return new AgentCodeError({
      code: 'rate_limit',
      message,
      retryable: true
    });
  }

  return new AgentCodeError({
    code: 'provider_error',
    message,
    retryable: isRetryableOpenAIError(errorName)
  });
}

function isOpenAIAuthError(errorName: string): boolean {
  return ['authentication_error', 'permission_error', 'invalid_api_key', 'invalid_request_error'].includes(errorName);
}

function isOpenAIRateLimitError(errorName: string): boolean {
  return ['rate_limit_error', 'rate_limit_exceeded', 'insufficient_quota'].includes(errorName);
}

function isRetryableOpenAIError(errorName: string): boolean {
  return ['server_error', 'api_error', 'service_unavailable', 'engine_overloaded'].includes(errorName);
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
