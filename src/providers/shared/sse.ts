import { createNetworkError } from './errors.js';

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

interface PendingSseEvent {
  event?: string;
  dataLines: string[];
  id?: string;
  retry?: number;
}

export interface ReadSseStreamOptions {
  signal?: AbortSignal;
}

export async function* readSseStream(
  stream: ReadableStream<Uint8Array>,
  options: ReadSseStreamOptions = {}
): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const abortReader = () => {
    void reader.cancel();
  };

  if (options.signal?.aborted === true) {
    abortReader();
  } else {
    options.signal?.addEventListener('abort', abortReader, { once: true });
  }
  const pendingEvent: PendingSseEvent = { dataLines: [] };
  let pendingText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      pendingText += decoder.decode(value, { stream: true });
      const parsedLines = takeCompleteSseLines(pendingText);
      pendingText = parsedLines.remainingText;

      for (const line of parsedLines.lines) {
        const event = applySseLine(line, pendingEvent);
        if (event !== undefined) {
          yield event;
        }
      }
    }

    pendingText += decoder.decode();

    if (pendingText.length > 0) {
      const event = applySseLine(pendingText, pendingEvent);
      if (event !== undefined) {
        yield event;
      }
    }

    const finalEvent = dispatchSseEvent(pendingEvent);
    if (finalEvent !== undefined) {
      yield finalEvent;
    }
  } finally {
    options.signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}

function takeCompleteSseLines(text: string): { lines: string[]; remainingText: string } {
  const lines: string[] = [];
  let lineStart = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '\n') {
      lines.push(text.slice(lineStart, index));
      index += 1;
      lineStart = index;
      continue;
    }

    if (char === '\r') {
      if (index === text.length - 1) {
        break;
      }

      lines.push(text.slice(lineStart, index));
      index += text[index + 1] === '\n' ? 2 : 1;
      lineStart = index;
      continue;
    }

    index += 1;
  }

  return {
    lines,
    remainingText: text.slice(lineStart)
  };
}

function applySseLine(line: string, pendingEvent: PendingSseEvent): SseEvent | undefined {
  if (line === '') {
    return dispatchSseEvent(pendingEvent);
  }

  if (line.startsWith(':')) {
    return undefined;
  }

  const separatorIndex = line.indexOf(':');
  const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
  const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
  const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

  switch (field) {
    case 'event':
      pendingEvent.event = value;
      break;
    case 'data':
      pendingEvent.dataLines.push(value);
      break;
    case 'id':
      if (!value.includes('\0')) {
        pendingEvent.id = value;
      }
      break;
    case 'retry': {
      const retry = Number.parseInt(value, 10);
      if (Number.isFinite(retry)) {
        pendingEvent.retry = retry;
      }
      break;
    }
  }

  return undefined;
}

function dispatchSseEvent(pendingEvent: PendingSseEvent): SseEvent | undefined {
  if (pendingEvent.dataLines.length === 0) {
    resetPendingEvent(pendingEvent);
    return undefined;
  }

  const event: SseEvent = {
    data: pendingEvent.dataLines.join('\n')
  };

  if (pendingEvent.event !== undefined) {
    event.event = pendingEvent.event;
  }

  if (pendingEvent.id !== undefined) {
    event.id = pendingEvent.id;
  }

  if (pendingEvent.retry !== undefined) {
    event.retry = pendingEvent.retry;
  }

  resetPendingEvent(pendingEvent);

  return event;
}

function resetPendingEvent(pendingEvent: PendingSseEvent): void {
  delete pendingEvent.event;
  pendingEvent.dataLines = [];
  delete pendingEvent.id;
  delete pendingEvent.retry;
}

export async function readNextSseEvent(
  iterator: AsyncIterator<SseEvent>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<IteratorResult<SseEvent>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<SseEvent>>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(createNetworkError('Provider stream timed out while waiting for data.'));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
