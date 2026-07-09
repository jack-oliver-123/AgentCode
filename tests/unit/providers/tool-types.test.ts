import { describe, expect, it } from 'vitest';

import type { ProviderRequest } from '../../../src/providers/types.js';
import { createDefaultToolRegistry } from '../../../src/tools/registry.js';
import { FakeProvider } from '../../helpers/FakeProvider.js';

describe('provider tool protocol types', () => {
  it('allows provider requests to carry tool declarations without affecting request recording', async () => {
    const provider = new FakeProvider([{ type: 'response.complete', finishReason: 'stop' }]);
    const tools = createDefaultToolRegistry().getProviderDeclarations();

    await drain(
      provider.stream({
        model: 'test-model',
        messages: [{ role: 'user', content: 'use a tool' }],
        thinking: { enabled: false },
        tools,
        toolChoice: 'auto',
      }),
    );

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: 'read_file',
        }),
      ]),
      toolChoice: 'auto',
    });
  });

  it('allows fake provider streams to emit internal tool call events', async () => {
    const provider = new FakeProvider([
      {
        type: 'tool.call',
        call: {
          id: 'call-read-file',
          name: 'read_file',
          argumentsText: '{"path":"README.md"}',
        },
      },
      { type: 'response.complete', finishReason: 'tool_calls' },
    ]);

    const events = await drain(
      provider.stream({
        model: 'test-model',
        messages: [{ role: 'user', content: 'read README' }],
        thinking: { enabled: false },
      }),
    );

    expect(events).toEqual([
      {
        type: 'tool.call',
        call: {
          id: 'call-read-file',
          name: 'read_file',
          argumentsText: '{"path":"README.md"}',
        },
      },
      { type: 'response.complete', finishReason: 'tool_calls' },
    ]);
  });

  it('can return different event sequences for multiple provider requests', async () => {
    const provider = new FakeProvider([
      [
        {
          type: 'tool.call',
          call: {
            id: 'call-read-file',
            name: 'read_file',
            argumentsText: '{"path":"README.md"}',
          },
        },
      ],
      [
        { type: 'content.delta', delta: 'final answer' },
        { type: 'response.complete', finishReason: 'stop' },
      ],
    ]);
    const request = {
      model: 'test-model',
      messages: [{ role: 'user' as const, content: 'read README' }],
      thinking: { enabled: false },
    };

    await expect(drain(provider.stream(request))).resolves.toEqual([
      {
        type: 'tool.call',
        call: {
          id: 'call-read-file',
          name: 'read_file',
          argumentsText: '{"path":"README.md"}',
        },
      },
    ]);
    await expect(drain(provider.stream(request))).resolves.toEqual([
      { type: 'content.delta', delta: 'final answer' },
      { type: 'response.complete', finishReason: 'stop' },
    ]);
    expect(provider.requests).toHaveLength(2);
  });

  it('records provider request snapshots instead of mutable request references', async () => {
    const provider = new FakeProvider([{ type: 'response.complete', finishReason: 'stop' }]);
    const tools = createDefaultToolRegistry().getProviderDeclarations();
    const request: ProviderRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'first' }],
      thinking: { enabled: false },
      tools,
      toolChoice: 'auto',
    };

    await drain(provider.stream(request));
    request.messages.push({ role: 'assistant', content: 'mutated later' });
    request.thinking.enabled = true;
    tools[0]!.inputSchema.required = ['mutated'];

    expect(provider.requests[0]).toMatchObject({
      messages: [{ role: 'user', content: 'first' }],
      thinking: { enabled: false },
      toolChoice: 'auto',
    });
    expect(provider.requests[0]?.tools?.[0]?.inputSchema.required).not.toEqual(['mutated']);
  });
});

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const drained: T[] = [];
  for await (const event of events) {
    drained.push(event);
  }
  return drained;
}
