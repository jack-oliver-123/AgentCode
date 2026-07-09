import type { ProviderProtocol } from '../../src/config/schema.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../../src/providers/types.js';

export type OnRequestCallback = (request: ProviderRequest, callIndex: number) => ProviderEvent[];

export class FakeProvider implements ChatModelProvider {
  readonly protocol: ProviderProtocol;
  readonly supportsExtendedThinking: boolean;
  readonly requests: ProviderRequest[] = [];

  private readonly eventSequences: ProviderEvent[][];
  private readonly onRequest?: OnRequestCallback;
  private releaseGate: (() => void) | undefined;
  private readonly gate: Promise<void> | undefined;

  constructor(
    events: ProviderEvent[] | ProviderEvent[][] | OnRequestCallback,
    options: {
      protocol?: ProviderProtocol;
      supportsExtendedThinking?: boolean;
      holdBeforeEvents?: boolean;
    } = {},
  ) {
    if (typeof events === 'function') {
      this.onRequest = events;
      this.eventSequences = [];
    } else {
      this.eventSequences = normalizeEventSequences(events);
    }
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

    const callIndex = this.requests.length - 1;
    const events = this.onRequest ? this.onRequest(request, callIndex) : (this.eventSequences[callIndex] ?? []);

    for (const event of events) {
      yield event;
    }
  }

  release(): void {
    this.releaseGate?.();
  }
}

/** 收集 async generator 的全部事件 */
export async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
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
              ...(tool.inputSchema.required !== undefined ? { required: [...tool.inputSchema.required] } : {}),
            },
          })),
        }
      : {}),
  };
}
