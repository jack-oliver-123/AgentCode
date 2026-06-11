import type { ProviderProtocol } from '../config/schema.js';
import type { PublicError } from '../shared/errors.js';

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  thinking: {
    enabled: boolean;
    budgetTokens?: number;
  };
  signal?: AbortSignal;
}

export type ProviderEvent =
  | { type: 'response.start' }
  | { type: 'content.delta'; delta: string }
  | { type: 'thinking.delta'; delta: string }
  | { type: 'response.complete'; finishReason?: string }
  | { type: 'response.error'; error: PublicError };

export interface ChatModelProvider {
  protocol: ProviderProtocol;
  supportsExtendedThinking: boolean;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}
