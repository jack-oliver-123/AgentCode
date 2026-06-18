import type { AgentConfig } from '../config/schema.js';
import type { ChatModelProvider, ChatMessage as ProviderChatMessage, ProviderEvent, ProviderRequest } from '../providers/types.js';
import { createId, type IdGenerator } from '../shared/ids.js';
import { toPublicError, type PublicError } from '../shared/errors.js';
import { executeToolCall } from '../tools/executor.js';
import type { ProviderToolCall, ToolExecutionContext, ToolExecutionResult, ToolRegistry } from '../tools/types.js';
import type { ChatMessage, ChatSessionDraft, ChatSessionEvent, ChatSessionState, MessageRole } from './types.js';

export interface ChatSessionControllerOptions {
  provider: ChatModelProvider;
  config: AgentConfig;
  createId?: IdGenerator;
  now?: () => number;
  toolRegistry?: ToolRegistry;
  cwd?: string;
  toolTimeoutMs?: number;
  maxToolOutputBytes?: number;
  toolSecrets?: readonly string[];
}

export interface SubmitUserTextOptions {
  signal?: AbortSignal;
}

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

type ProviderTurnOutcome = { type: 'completed' } | { type: 'tool_call'; call: ProviderToolCall } | { type: 'failed' };

export class ChatSessionController {
  private readonly provider: ChatModelProvider;
  private readonly config: AgentConfig;
  private readonly createId: IdGenerator;
  private readonly now: () => number;
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly cwd: string;
  private readonly toolTimeoutMs: number;
  private readonly maxToolOutputBytes: number;
  private readonly toolSecrets: readonly string[];
  private readonly messages: ChatMessage[] = [];
  private readonly contextMessages: ChatMessage[] = [];
  private draft: ChatSessionDraft | undefined;
  private status: ChatSessionState['status'] = 'idle';
  private lastError: PublicError | undefined;

  constructor(options: ChatSessionControllerOptions) {
    this.provider = options.provider;
    this.config = options.config;
    this.createId = options.createId ?? createId;
    this.now = options.now ?? Date.now;
    this.toolRegistry = options.toolRegistry;
    this.cwd = options.cwd ?? process.cwd();
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.maxToolOutputBytes = options.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
    this.toolSecrets = options.toolSecrets ?? [];
  }

  getState(): ChatSessionState {
    return this.snapshotState();
  }

  async *submitUserText(text: string, options: SubmitUserTextOptions = {}): AsyncIterable<ChatSessionEvent> {
    if (this.status === 'streaming') {
      this.lastError = {
        code: 'provider_error',
        message: 'Cannot submit a new message while the previous response is still streaming.',
        retryable: false
      };
      yield this.createStateChangedEvent();
      return;
    }

    const userMessage = this.createMessage('user', text);
    this.messages.push(userMessage);
    this.draft = {
      id: this.createId('draft'),
      visibleText: '',
      thinkingText: '',
      activity: { type: 'thinking' }
    };
    this.status = 'streaming';
    this.lastError = undefined;
    yield this.createStateChangedEvent();

    try {
      const initialMessages = [...this.contextMessages, userMessage].map(toProviderMessage);
      const firstTurnOutcome = yield* this.streamProviderTurn(
        this.createProviderRequest(initialMessages, options.signal, this.toolRegistry === undefined ? undefined : 'auto'),
        userMessage,
        'allow_tool_call'
      );

      if (firstTurnOutcome.type !== 'tool_call') {
        return;
      }

      if (this.toolRegistry === undefined) {
        this.failTurn(userMessage, {
          code: 'protocol_error',
          message: 'Provider returned a tool call before tool execution is enabled.',
          retryable: false
        });
        yield this.createStateChangedEvent();
        return;
      }

      const preToolContent = this.requireDraft().visibleText;
      this.setToolActivity(this.getToolActivityName(firstTurnOutcome.call));
      yield this.createStateChangedEvent();

      const toolResult = await executeToolCall(firstTurnOutcome.call, this.toolRegistry, this.createToolExecutionContext(options.signal));
      const secondTurnMessages = [
        ...initialMessages,
        ...createToolContinuationMessages(firstTurnOutcome.call, toolResult, preToolContent)
      ];
      this.resetDraftForFinalAnswer();
      yield this.createStateChangedEvent();

      yield* this.streamProviderTurn(this.createProviderRequest(secondTurnMessages, options.signal, 'none'), userMessage, 'disallow_tool_call');
    } catch (error) {
      this.failTurn(userMessage, toPublicError(error));
      yield this.createStateChangedEvent();
    }
  }

  private async *streamProviderTurn(
    request: ProviderRequest,
    userMessage: ChatMessage,
    toolPolicy: 'allow_tool_call' | 'disallow_tool_call'
  ): AsyncGenerator<ChatSessionEvent, ProviderTurnOutcome, unknown> {
    for await (const event of this.provider.stream(request)) {
      const outcome = this.applyProviderEvent(event, userMessage, toolPolicy);
      if (outcome === undefined) {
        if (event.type === 'content.delta' || event.type === 'thinking.delta') {
          yield this.createStateChangedEvent();
        }
        continue;
      }

      yield this.createStateChangedEvent();
      return outcome;
    }

    this.failTurn(userMessage, {
      code: 'protocol_error',
      message: 'Provider stream ended without response.complete or response.error.',
      retryable: false
    });
    yield this.createStateChangedEvent();
    return { type: 'failed' };
  }

  private applyProviderEvent(
    event: ProviderEvent,
    userMessage: ChatMessage,
    toolPolicy: 'allow_tool_call' | 'disallow_tool_call'
  ): ProviderTurnOutcome | undefined {
    switch (event.type) {
      case 'response.start':
        return undefined;
      case 'content.delta': {
        const draft = this.requireDraft();
        this.draft = {
          ...draft,
          visibleText: `${draft.visibleText}${event.delta}`
        };
        return undefined;
      }
      case 'thinking.delta': {
        const draft = this.requireDraft();
        this.draft = {
          ...draft,
          thinkingText: `${draft.thinkingText}${event.delta}`
        };
        return undefined;
      }
      case 'response.error':
        this.failTurn(userMessage, event.error);
        return { type: 'failed' };
      case 'tool.call':
        if (toolPolicy === 'allow_tool_call') {
          return { type: 'tool_call', call: event.call };
        }

        this.failTurn(userMessage, {
          code: 'protocol_error',
          message: 'Provider returned a second tool call; only one tool call is allowed per turn.',
          retryable: false
        });
        return { type: 'failed' };
      case 'response.complete':
        this.completeTurn(userMessage, event.finishReason);
        return { type: 'completed' };
    }
  }

  private createProviderRequest(
    messages: ProviderChatMessage[],
    signal: AbortSignal | undefined,
    toolChoice: 'auto' | 'none' | undefined
  ): ProviderRequest {
    return {
      model: this.config.model,
      messages,
      thinking: this.config.thinking,
      ...(toolChoice === 'auto' && this.toolRegistry !== undefined
        ? { tools: this.toolRegistry.getProviderDeclarations(), toolChoice }
        : {}),
      ...(toolChoice === 'none' ? { toolChoice } : {}),
      ...(signal !== undefined ? { signal } : {})
    };
  }

  private createToolExecutionContext(signal: AbortSignal | undefined): ToolExecutionContext {
    return {
      cwd: this.cwd,
      timeoutMs: this.toolTimeoutMs,
      secrets: [this.config.apiKey, ...this.toolSecrets],
      maxOutputBytes: this.maxToolOutputBytes,
      ...(signal !== undefined ? { signal } : {})
    };
  }

  private setToolActivity(toolName: string): void {
    const draft = this.requireDraft();
    this.draft = {
      ...draft,
      activity: { type: 'tool', toolName },
      visibleText: ''
    };
  }

  private getToolActivityName(call: ProviderToolCall): string {
    return this.toolRegistry?.get(call.name)?.name ?? 'tool';
  }

  private resetDraftForFinalAnswer(): void {
    const draft = this.requireDraft();
    this.draft = {
      ...draft,
      visibleText: '',
      thinkingText: '',
      activity: { type: 'thinking' }
    };
  }

  private completeTurn(userMessage: ChatMessage, finishReason: string | undefined): void {
    const draft = this.requireDraft();
    const assistantMessage = this.createMessage('assistant', draft.visibleText, finishReason);
    this.messages.push(assistantMessage);
    this.contextMessages.push(userMessage, assistantMessage);
    this.draft = undefined;
    this.status = 'idle';
    this.lastError = undefined;
  }

  private failTurn(userMessage: ChatMessage, error: PublicError): void {
    if (!this.contextMessages.some((message) => message.id === userMessage.id)) {
      this.contextMessages.push(userMessage);
    }

    this.draft = undefined;
    this.status = 'error';
    this.lastError = error;
  }

  private createMessage(role: MessageRole, text: string, finishReason?: string): ChatMessage {
    const message: ChatMessage = {
      id: this.createId(role),
      role,
      parts: [{ type: 'text', text }],
      createdAt: this.now()
    };

    if (role === 'assistant') {
      message.meta = {
        model: this.config.model,
        provider: this.provider.protocol,
        ...(finishReason !== undefined ? { finishReason } : {})
      };
    }

    return message;
  }

  private requireDraft(): ChatSessionDraft {
    if (this.draft === undefined) {
      throw new Error('Chat session draft is not available.');
    }

    return this.draft;
  }

  private createStateChangedEvent(): ChatSessionEvent {
    return {
      type: 'state.changed',
      state: this.snapshotState()
    };
  }

  private snapshotState(): ChatSessionState {
    const state: ChatSessionState = {
      messages: this.messages.map(cloneMessage),
      status: this.status
    };

    if (this.draft !== undefined) {
      state.draft = { ...this.draft };
    }

    if (this.lastError !== undefined) {
      state.lastError = { ...this.lastError };
    }

    return state;
  }
}

function toProviderMessage(message: ChatMessage): ProviderChatMessage {
  return {
    role: message.role,
    content: message.parts.map((part) => part.text).join('')
  };
}

function createToolContinuationMessages(call: ProviderToolCall, result: ToolExecutionResult, preToolContent: string): ProviderChatMessage[] {
  return [
    {
      role: 'assistant',
      content: preToolContent,
      toolCalls: [call]
    },
    {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content: JSON.stringify(result),
      isError: !result.ok
    }
  ];
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
    ...(message.meta !== undefined ? { meta: { ...message.meta } } : {})
  };
}
