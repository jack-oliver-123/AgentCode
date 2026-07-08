import type { AgentConfig } from '../../config/schema.js';
import { AgentCodeError, toPublicError } from '../../shared/errors.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest, UsageInfo } from '../types.js';
import { createCancellationError, createProtocolError } from '../shared/errors.js';
import { joinEndpoint } from '../shared/endpoint.js';
import { fetchJsonStream, type FetchJsonOptions, type FetchTransportOptions } from '../shared/fetchTransport.js';
import { readNextSseEvent, readSseStream } from '../shared/sse.js';

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: {
      cached_tokens?: unknown;
    };
  };
}

interface OpenAIToolCallDelta {
  index?: unknown;
  id?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface OpenAIToolCallAccumulator {
  id: string | undefined;
  name: string | undefined;
  argumentsText: string;
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
        body: createOpenAIRequestBody(request),
        ...(request.signal !== undefined ? { signal: request.signal } : {})
      };

      const transportOptions: FetchTransportOptions = {
        timeoutMs: this.config.request.timeoutMs,
        ...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {})
      };

      const stream = await fetchJsonStream(requestOptions, transportOptions);

      let finishReason: string | undefined;
      const toolCalls = new Map<number, OpenAIToolCallAccumulator>();
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

          collectToolCallDeltas(toolCalls, choice?.delta?.tool_calls);

          if (chunk.usage !== undefined) {
            const usageEvent = createUsageEvent(chunk.usage);
            if (usageEvent !== undefined) {
              yield usageEvent;
            }
          }

          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason;
            if (finishReason === 'tool_calls') {
              yield* emitToolCallEvents(toolCalls);
            }
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

function createOpenAIRequestBody(request: ProviderRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  if (request.system !== undefined && request.system.length > 0) {
    messages.push({ role: 'system', content: request.system });
  }

  messages.push(...request.messages.map(toOpenAIMessage));

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true }
  };

  if (request.toolChoice !== 'none' && request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  }

  if (request.toolChoice !== undefined) {
    body.tool_choice = request.toolChoice;
  }

  return body;
}

function toOpenAIMessage(message: ProviderRequest['messages'][number]): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }

  if ('toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.argumentsText
        }
      }))
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function collectToolCallDeltas(toolCalls: Map<number, OpenAIToolCallAccumulator>, deltas: OpenAIToolCallDelta[] | undefined): void {
  if (deltas === undefined) {
    return;
  }

  for (const delta of deltas) {
    if (typeof delta.index !== 'number' || !Number.isInteger(delta.index) || delta.index < 0) {
      throw createProtocolError('OpenAI-compatible provider returned an invalid tool call index.');
    }

    const existing = toolCalls.get(delta.index) ?? { id: undefined, name: undefined, argumentsText: '' };

    if (delta.id !== undefined) {
      if (typeof delta.id !== 'string') {
        throw createProtocolError('OpenAI-compatible provider returned an invalid tool call id.');
      }
      // 跳过空字符串（某些 OpenAI 兼容代理在后续 delta 中发送空 id）
      if (delta.id.length > 0) {
        existing.id = delta.id;
      }
    }

    if (delta.function?.name !== undefined) {
      if (typeof delta.function.name !== 'string') {
        throw createProtocolError('OpenAI-compatible provider returned an invalid tool call name.');
      }
      // 跳过空字符串（某些 OpenAI 兼容代理在后续 delta 中发送空 name）
      if (delta.function.name.length > 0) {
        existing.name = delta.function.name;
      }
    }

    if (delta.function?.arguments !== undefined) {
      if (typeof delta.function.arguments !== 'string') {
        throw createProtocolError('OpenAI-compatible provider returned invalid tool call arguments.');
      }
      existing.argumentsText = `${existing.argumentsText}${delta.function.arguments}`;
    }

    toolCalls.set(delta.index, existing);
  }
}

function* emitToolCallEvents(toolCalls: Map<number, OpenAIToolCallAccumulator>): Generator<ProviderEvent> {
  const sorted = [...toolCalls.entries()].sort(([left], [right]) => left - right);

  for (const [, toolCall] of sorted) {
    if (toolCall.id === undefined || toolCall.name === undefined) {
      throw createProtocolError('OpenAI-compatible provider finished with tool_calls but did not provide a complete tool call.');
    }

    yield {
      type: 'tool.call',
      call: {
        id: toolCall.id,
        name: toolCall.name,
        argumentsText: toolCall.argumentsText
      }
    };
  }
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
  return ['authentication_error', 'permission_error', 'invalid_api_key'].includes(errorName);
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

function createUsageEvent(usage: NonNullable<OpenAIChatCompletionChunk['usage']>): ProviderEvent | undefined {
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;

  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  const cachedTokens = typeof usage.prompt_tokens_details?.cached_tokens === 'number'
    ? usage.prompt_tokens_details.cached_tokens
    : undefined;

  const usageInfo: UsageInfo = {
    inputTokens,
    outputTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {})
  };

  return { type: 'response.usage', usage: usageInfo };
}
