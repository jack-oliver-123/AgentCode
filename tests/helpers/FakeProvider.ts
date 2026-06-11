import type { ProviderProtocol } from '../../src/config/schema.js';
import type { ChatModelProvider, ProviderEvent, ProviderRequest } from '../../src/providers/types.js';

export class FakeProvider implements ChatModelProvider {
  readonly protocol: ProviderProtocol;
  readonly supportsExtendedThinking: boolean;
  readonly requests: ProviderRequest[] = [];

  private readonly events: ProviderEvent[];
  private releaseGate: (() => void) | undefined;
  private readonly gate: Promise<void> | undefined;

  constructor(
    events: ProviderEvent[],
    options: {
      protocol?: ProviderProtocol;
      supportsExtendedThinking?: boolean;
      holdBeforeEvents?: boolean;
    } = {}
  ) {
    this.events = events;
    this.protocol = options.protocol ?? 'openai';
    this.supportsExtendedThinking = options.supportsExtendedThinking ?? false;

    if (options.holdBeforeEvents === true) {
      this.gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
      });
    }
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);

    if (this.gate !== undefined) {
      await this.gate;
    }

    for (const event of this.events) {
      yield event;
    }
  }

  release(): void {
    this.releaseGate?.();
  }
}
