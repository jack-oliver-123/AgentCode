import type { AgentConfig } from '../config/schema.js';
import type { ChatModelProvider, ChatMessage as ProviderChatMessage, ProviderRequest } from '../providers/types.js';
import { createId, type IdGenerator } from '../shared/ids.js';
import { toPublicError, type PublicError } from '../shared/errors.js';
import type { ChatMessage, ChatSessionDraft, ChatSessionEvent, ChatSessionState, MessageRole } from './types.js';

export interface ChatSessionControllerOptions {
  provider: ChatModelProvider;
  config: AgentConfig;
  createId?: IdGenerator;
  now?: () => number;
}

export interface SubmitUserTextOptions {
  signal?: AbortSignal;
}

export class ChatSessionController {
  private readonly provider: ChatModelProvider;
  private readonly config: AgentConfig;
  private readonly createId: IdGenerator;
  private readonly now: () => number;
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
      thinkingText: ''
    };
    this.status = 'streaming';
    this.lastError = undefined;
    yield this.createStateChangedEvent();

    try {
      for await (const event of this.provider.stream(this.createProviderRequest(userMessage, options.signal))) {
        switch (event.type) {
          case 'response.start':
            break;
          case 'content.delta': {
            const draft = this.requireDraft();
            this.draft = {
              ...draft,
              visibleText: `${draft.visibleText}${event.delta}`
            };
            yield this.createStateChangedEvent();
            break;
          }
          case 'thinking.delta': {
            const draft = this.requireDraft();
            this.draft = {
              ...draft,
              thinkingText: `${draft.thinkingText}${event.delta}`
            };
            yield this.createStateChangedEvent();
            break;
          }
          case 'response.error':
            this.failTurn(userMessage, event.error);
            yield this.createStateChangedEvent();
            return;
          case 'response.complete':
            this.completeTurn(userMessage, event.finishReason);
            yield this.createStateChangedEvent();
            return;
        }
      }

      this.failTurn(userMessage, {
        code: 'protocol_error',
        message: 'Provider stream ended without response.complete or response.error.',
        retryable: false
      });
      yield this.createStateChangedEvent();
    } catch (error) {
      this.failTurn(userMessage, toPublicError(error));
      yield this.createStateChangedEvent();
    }
  }

  private createProviderRequest(userMessage: ChatMessage, signal: AbortSignal | undefined): ProviderRequest {
    return {
      model: this.config.model,
      messages: [...this.contextMessages, userMessage].map(toProviderMessage),
      thinking: this.config.thinking,
      ...(signal !== undefined ? { signal } : {})
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

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
    ...(message.meta !== undefined ? { meta: { ...message.meta } } : {})
  };
}
