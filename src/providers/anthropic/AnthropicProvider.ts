import type { AgentConfig } from '../../config/schema.js';
import { AgentCodeError, toPublicError } from '../../shared/errors.js';
import { createCancellationError, createProtocolError } from '../shared/errors.js';
import { joinEndpoint } from '../shared/endpoint.js';
import { fetchJsonStream, type FetchJsonOptions, type FetchTransportOptions } from '../shared/fetchTransport.js';
import { readNextSseEvent, readSseStream } from '../shared/sse.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../types.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_BUDGET_TOKENS = 1024;

interface AnthropicStreamEvent {
  type?: unknown;
  index?: unknown;
  content_block?: {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
  };
  delta?: {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    partial_json?: unknown;
  };
}

interface AnthropicToolUseAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

export interface AnthropicProviderOptions {
  config: AgentConfig;
  fetch?: FetchTransportOptions['fetch'];
}

export class AnthropicProvider implements ChatModelProvider {
  readonly protocol = 'anthropic';
  readonly supportsExtendedThinking = true;

  private readonly config: AgentConfig;
  private readonly fetchImpl: FetchTransportOptions['fetch'];

  constructor(options: AnthropicProviderOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    try {
      yield { type: 'response.start' };

      const requestOptions: FetchJsonOptions = {
        url: joinEndpoint(this.config.baseUrl, getMessagesEndpointPath(this.config.baseUrl)),
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...this.config.request.headers
        },
        body: createAnthropicRequestBody(request),
        ...(request.signal !== undefined ? { signal: request.signal } : {})
      };
      const transportOptions: FetchTransportOptions = {
        timeoutMs: this.config.request.timeoutMs,
        ...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {})
      };
      const stream = await fetchJsonStream(requestOptions, transportOptions);

      let finishReason: string | undefined;
      let emittedToolCall = false;
      const toolUses = new Map<number, AnthropicToolUseAccumulator>();
      const streamTimeoutController = new AbortController();
      const sseIterator = readSseStream(stream, { signal: streamTimeoutController.signal })[Symbol.asyncIterator]();

      try {
        while (true) {
          const { done, value: sseEvent } = await readNextSseEvent(sseIterator, this.config.request.timeoutMs, () => {
            streamTimeoutController.abort();
          });

          if (done === true) {
            throw createProtocolError('Anthropic provider stream ended before message_stop.');
          }

          if (sseEvent.event === 'error') {
            yield {
              type: 'response.error',
              error: toPublicError(parseAnthropicStreamError(sseEvent.data))
            };
            return;
          }

          const event = parseAnthropicEvent(sseEvent.data);

          if (event.type === 'content_block_start') {
            collectToolUseStart(toolUses, event);
          }

          if (event.type === 'content_block_delta') {
            const deltaType = event.delta?.type;
            if (deltaType === 'text_delta' && typeof event.delta?.text === 'string' && event.delta.text.length > 0) {
              yield {
                type: 'content.delta',
                delta: event.delta.text
              };
            }

            if (
              deltaType === 'thinking_delta' &&
              typeof event.delta?.thinking === 'string' &&
              event.delta.thinking.length > 0
            ) {
              yield {
                type: 'thinking.delta',
                delta: event.delta.thinking
              };
            }

            if (deltaType === 'input_json_delta') {
              collectToolUseInputDelta(toolUses, event);
            }
          }

          if (event.type === 'content_block_stop' && !emittedToolCall) {
            const toolCallEvent = createToolCallEvent(event, toolUses);
            if (toolCallEvent !== undefined) {
              emittedToolCall = true;
              yield toolCallEvent;
            }
          }

          if (event.type === 'message_delta') {
            finishReason = extractStopReason(event);
          }

          if (event.type === 'message_stop') {
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

function getMessagesEndpointPath(baseUrl: string): string {
  const pathname = new URL(baseUrl).pathname.replace(/\/+$/, '');
  return pathname.endsWith('/v1') ? '/messages' : '/v1/messages';
}

function createAnthropicRequestBody(request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toAnthropicMessage),
    stream: true,
    max_tokens: getMaxTokens(request)
  };

  if (request.toolChoice !== 'none' && request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));
  }

  if (request.thinking.enabled) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: request.thinking.budgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS
    };
  }

  return body;
}

function toAnthropicMessage(message: ProviderRequest['messages'][number]): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError
        }
      ]
    };
  }

  if ('toolCalls' in message) {
    return {
      role: 'assistant',
      content: [
        ...(message.content.length > 0 ? [{ type: 'text', text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseToolInput(call.argumentsText)
        }))
      ]
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function parseToolInput(argumentsText: string): unknown {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getMaxTokens(request: ProviderRequest): number {
  if (!request.thinking.enabled || request.thinking.budgetTokens === undefined) {
    return DEFAULT_MAX_TOKENS;
  }

  return Math.max(DEFAULT_MAX_TOKENS, request.thinking.budgetTokens + DEFAULT_THINKING_BUDGET_TOKENS);
}

function collectToolUseStart(toolUses: Map<number, AnthropicToolUseAccumulator>, event: AnthropicStreamEvent): void {
  if (event.content_block?.type !== 'tool_use') {
    return;
  }

  const index = parseAnthropicBlockIndex(event);
  const id = event.content_block.id;
  const name = event.content_block.name;

  if (typeof id !== 'string' || id.length === 0) {
    throw createProtocolError('Anthropic provider returned an invalid tool_use id.');
  }

  if (typeof name !== 'string' || name.length === 0) {
    throw createProtocolError('Anthropic provider returned an invalid tool_use name.');
  }

  toolUses.set(index, {
    id,
    name,
    argumentsText: createInitialToolUseArgumentsText(event.content_block.input)
  });
}

function collectToolUseInputDelta(toolUses: Map<number, AnthropicToolUseAccumulator>, event: AnthropicStreamEvent): void {
  const index = parseAnthropicBlockIndex(event);
  const toolUse = toolUses.get(index);

  if (toolUse === undefined) {
    throw createProtocolError('Anthropic provider returned tool input for an unknown content block.');
  }

  if (typeof event.delta?.partial_json !== 'string') {
    throw createProtocolError('Anthropic provider returned invalid tool input JSON delta.');
  }

  toolUse.argumentsText = `${toolUse.argumentsText}${event.delta.partial_json}`;
}

function createToolCallEvent(event: AnthropicStreamEvent, toolUses: Map<number, AnthropicToolUseAccumulator>): ProviderEvent | undefined {
  const index = parseAnthropicBlockIndex(event);
  const toolUse = toolUses.get(index);

  if (toolUse === undefined) {
    return undefined;
  }

  return {
    type: 'tool.call',
    call: {
      id: toolUse.id,
      name: toolUse.name,
      argumentsText: toolUse.argumentsText
    }
  };
}

function parseAnthropicBlockIndex(event: AnthropicStreamEvent): number {
  if (typeof event.index !== 'number' || !Number.isInteger(event.index) || event.index < 0) {
    throw createProtocolError('Anthropic provider returned an invalid content block index.');
  }

  return event.index;
}

function createInitialToolUseArgumentsText(input: unknown): string {
  if (input === undefined) {
    return '';
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw createProtocolError('Anthropic provider returned invalid tool_use input.');
  }

  return Object.keys(input).length > 0 ? JSON.stringify(input) : '';
}

function parseAnthropicStreamError(data: string): AgentCodeError {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) {
      return createProtocolError('Anthropic provider returned an invalid SSE error event.');
    }

    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) {
      return createProtocolError('Anthropic provider returned an invalid SSE error payload.');
    }

    const type = (error as { type?: unknown }).type;
    const message = (error as { message?: unknown }).message;
    if (typeof type !== 'string' || typeof message !== 'string') {
      return createProtocolError('Anthropic provider returned an invalid SSE error payload.');
    }

    return createAnthropicError(type, message);
  } catch {
    return createProtocolError('Anthropic provider returned invalid JSON in an SSE error event.');
  }
}

function createAnthropicError(type: string, message: string): AgentCodeError {
  if (type === 'authentication_error' || type === 'permission_error') {
    return new AgentCodeError({
      code: 'auth_error',
      message,
      retryable: false
    });
  }

  if (type === 'rate_limit_error') {
    return new AgentCodeError({
      code: 'rate_limit',
      message,
      retryable: true
    });
  }

  if (type === 'overloaded_error' || type === 'api_error') {
    return new AgentCodeError({
      code: 'provider_error',
      message,
      retryable: true
    });
  }

  return new AgentCodeError({
    code: 'provider_error',
    message,
    retryable: false
  });
}

function parseAnthropicEvent(data: string): AnthropicStreamEvent {
  try {
    const parsed = JSON.parse(data) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      throw createProtocolError('Anthropic provider returned a non-object stream event.');
    }

    return parsed as AnthropicStreamEvent;
  } catch (error) {
    if (error instanceof AgentCodeError) {
      throw error;
    }

    throw createProtocolError('Anthropic provider returned invalid JSON in the stream.');
  }
}

function extractStopReason(event: AnthropicStreamEvent): string | undefined {
  if (typeof event.delta !== 'object' || event.delta === null || !('stop_reason' in event.delta)) {
    return undefined;
  }

  const stopReason = (event.delta as { stop_reason?: unknown }).stop_reason;
  return typeof stopReason === 'string' ? stopReason : undefined;
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
