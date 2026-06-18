import type { ProviderProtocol } from '../../src/config/schema.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../../src/providers/types.js';

export class FakeProvider implements ChatModelProvider {
  readonly protocol: ProviderProtocol;
  readonly supportsExtendedThinking: boolean;
  readonly requests: ProviderRequest[] = [];

  private readonly eventSequences: ProviderEvent[][];
  private releaseGate: (() => void) | undefined;
  private readonly gate: Promise<void> | undefined;

  constructor(
    events: ProviderEvent[] | ProviderEvent[][],
    options: {
      protocol?: ProviderProtocol;
      supportsExtendedThinking?: boolean;
      holdBeforeEvents?: boolean;
    } = {}
  ) {
    this.eventSequences = normalizeEventSequences(events);
    this.protocol = options.protocol ?? 'openai';
    this.supportsExtendedThinking = options.supportsExtendedThinking ?? false;

    if (options.holdBeforeEvents === true) {
      this.gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
      });
    }
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(cloneProviderRequest(request));

    if (this.gate !== undefined) {
      await this.gate;
    }

    const events = this.eventSequences[this.requests.length - 1] ?? [];
    for (const event of events) {
      yield event;
    }
  }

  release(): void {
    this.releaseGate?.();
  }
}

function normalizeEventSequences(events: ProviderEvent[] | ProviderEvent[][]): ProviderEvent[][] {
  return Array.isArray(events[0]) ? (events as ProviderEvent[][]) : [events as ProviderEvent[]];
}

function cloneProviderRequest(request: ProviderRequest): ProviderRequest {
  return {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
    thinking: { ...request.thinking },
    ...(request.tools !== undefined
      ? {
          tools: request.tools.map((tool) => ({
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: { ...tool.inputSchema.properties },
              ...(tool.inputSchema.required !== undefined ? { required: [...tool.inputSchema.required] } : {})
            }
          }))
        }
      : {})
  };
}
