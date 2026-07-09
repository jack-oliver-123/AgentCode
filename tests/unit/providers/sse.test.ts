import { describe, expect, it } from 'vitest';

import { type SseEvent, readSseStream } from '../../../src/providers/shared/sse.js';

const encoder = new TextEncoder();

describe('readSseStream', () => {
  it('parses events across chunk boundaries without dropping the final delta', async () => {
    const stream = streamFromChunks(['data: {"delta":"Hel', 'lo"}\n\n', 'data: [DONE]\n\n']);

    await expect(collectSseData(stream)).resolves.toEqual(['{"delta":"Hello"}', '[DONE]']);
  });

  it('combines multiple data lines in one event', async () => {
    const stream = streamFromChunks(['event: message\ndata: first\ndata: second\nid: abc\nretry: 1500\n\n']);

    const events = await collectSseEvents(stream);

    expect(events).toEqual([
      {
        event: 'message',
        data: 'first\nsecond',
        id: 'abc',
        retry: 1500,
      },
    ]);
  });

  it('does not dispatch early when CRLF is split across chunks', async () => {
    const stream = streamFromChunks(['data: first\r', '\ndata: second\r\n\r\n']);

    await expect(collectSseData(stream)).resolves.toEqual(['first\nsecond']);
  });

  it('ignores keepalive comments and empty dispatches', async () => {
    const stream = streamFromChunks([': keepalive\n\n', 'data: visible\n\n', ': another heartbeat\n\n']);

    await expect(collectSseData(stream)).resolves.toEqual(['visible']);
  });

  it('does not dispatch control-only frames without data lines', async () => {
    const stream = streamFromChunks(['retry: 1000\nid: control-only\n\n', 'data: visible\n\n']);

    await expect(collectSseEvents(stream)).resolves.toEqual([{ data: 'visible' }]);
  });

  it('emits the last event even when the stream does not end with a blank line', async () => {
    const stream = streamFromChunks(['data: final-delta']);

    await expect(collectSseData(stream)).resolves.toEqual(['final-delta']);
  });

  it('yields available events before the response stream finishes', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });

    const iterator = readSseStream(stream)[Symbol.asyncIterator]();
    controller?.enqueue(encoder.encode('data: early\n\n'));

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        data: 'early',
      },
    });

    controller?.enqueue(encoder.encode('data: late\n\n'));
    controller?.close();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        data: 'late',
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('preserves error frames for provider adapters to map later', async () => {
    const stream = streamFromChunks(['event: error\ndata: {"message":"bad"}\n\n']);

    const events = await collectSseEvents(stream);

    expect(events).toEqual([
      {
        event: 'error',
        data: '{"message":"bad"}',
      },
    ]);
  });

  it('keeps UTF-8 decoder state isolated across concurrent streams', async () => {
    const encoded = encoder.encode('data: 你好\n\n');
    const streamA = streamFromByteChunks([encoded.slice(0, 8), encoded.slice(8)]);
    const streamB = streamFromChunks(['data: world\n\n']);

    await expect(Promise.all([collectSseData(streamA), collectSseData(streamB)])).resolves.toEqual([
      ['你好'],
      ['world'],
    ]);
  });
});

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return streamFromByteChunks(chunks.map((chunk) => encoder.encode(chunk)));
}

function streamFromByteChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
}

async function collectSseData(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const events = await collectSseEvents(stream);
  return events.map((event) => event.data);
}

async function collectSseEvents(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];

  for await (const event of readSseStream(stream)) {
    events.push(event);
  }

  return events;
}
