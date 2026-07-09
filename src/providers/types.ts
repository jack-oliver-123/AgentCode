import type { ProviderProtocol } from '../config/schema.js';
import type { PublicError } from '../shared/errors.js';
import type { ProviderToolCall, ProviderToolDeclaration } from '../tools/types.js';

export type MessageRole = 'user' | 'assistant';

export type ChatMessage = ProviderTextMessage | ProviderAssistantToolCallMessage | ProviderToolResultMessage;

export interface ProviderTextMessage {
  role: MessageRole;
  content: string;
}

export interface ProviderAssistantToolCallMessage {
  role: 'assistant';
  content: string;
  toolCalls: ProviderToolCall[];
}

export interface ProviderToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
  thinking: {
    enabled: boolean;
    budgetTokens?: number;
  };
  tools?: ProviderToolDeclaration[];
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cachedTokens?: number;
}

export type ProviderEvent =
  | { type: 'response.start' }
  | { type: 'content.delta'; delta: string }
  | { type: 'thinking.delta'; delta: string }
  | { type: 'tool.call'; call: ProviderToolCall }
  | { type: 'response.usage'; usage: UsageInfo }
  | { type: 'response.complete'; finishReason?: string }
  | { type: 'response.error'; error: PublicError };

export interface ChatModelProvider {
  protocol: ProviderProtocol;
  supportsExtendedThinking: boolean;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}
