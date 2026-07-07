import type { AgentLoopMode } from '../agent/types.js';
import type { ProviderProtocol } from '../config/schema.js';
import type { PublicError } from '../shared/errors.js';

export type MessageRole = 'user' | 'assistant';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; summary: string; isError: boolean };

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
  /** 当前 Agent Loop 运行模式 */
  mode: AgentLoopMode;
  /** 瞬态系统提示（如 "Switched to plan mode"），下次状态更新后清除 */
  notice?: string;
}

export type ChatSessionEvent = { type: 'state.changed'; state: ChatSessionState };
