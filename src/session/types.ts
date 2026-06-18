import type { ProviderProtocol } from '../config/schema.js';
import type { PublicError } from '../shared/errors.js';

export type MessageRole = 'user' | 'assistant';

export type MessagePart = { type: 'text'; text: string };

export interface ChatMessage {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
  meta?: {
    model?: string;
    provider?: ProviderProtocol;
    finishReason?: string;
  };
}

export type ChatSessionDraftActivity =
  | { type: 'thinking' }
  | { type: 'tool'; toolName: string };

export interface ChatSessionDraft {
  id: string;
  visibleText: string;
  thinkingText: string;
  activity: ChatSessionDraftActivity;
}

export type ChatSessionStatus = 'idle' | 'streaming' | 'error';

export interface ChatSessionState {
  messages: ChatMessage[];
  draft?: ChatSessionDraft;
  status: ChatSessionStatus;
  lastError?: PublicError;
}

export type ChatSessionEvent = { type: 'state.changed'; state: ChatSessionState };
