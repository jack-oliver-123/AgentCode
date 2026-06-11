import type { AgentConfig } from '../config/schema.js';
import { AnthropicProvider } from './anthropic/AnthropicProvider.js';
import { OpenAIProvider } from './openai/OpenAIProvider.js';
import type { ChatModelProvider } from './types.js';

export interface CreateProviderOptions {
  config: AgentConfig;
  fetch?: typeof fetch;
}

export function createProvider(options: CreateProviderOptions): ChatModelProvider {
  switch (options.config.protocol) {
    case 'openai':
      return new OpenAIProvider(options);
    case 'anthropic':
      return new AnthropicProvider(options);
  }
}
