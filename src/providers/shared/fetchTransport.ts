import { AgentCodeError } from '../../shared/errors.js';
import {
  createCancellationError,
  createNetworkError,
  createProtocolError,
  createProviderStatusError,
} from './errors.js';

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface FetchTransportOptions {
  fetch?: typeof fetch;
  timeoutMs: number;
}

export interface FetchJsonOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export async function fetchJsonStream(
  request: FetchJsonOptions,
  options: FetchTransportOptions,
): Promise<ReadableStream<Uint8Array>> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutController = new AbortController();
  let abortSource: 'timeout' | 'caller' | undefined;
  const timeout = setTimeout(() => {
    abortSource ??= 'timeout';
    timeoutController.abort();
  }, options.timeoutMs);
  const signal = composeAbortSignals(timeoutController.signal, request.signal, (source) => {
    abortSource ??= source;
  });

  try {
    const init: RequestInit = {
      method: request.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...request.headers,
      },
      signal,
    };

    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
    }

    const response = await fetchImpl(request.url, init);

    if (!response.ok) {
      if (response.status === 413) {
        await cancelResponseBodySafely(response);
        throw createInputTooLongError(response.status);
      }
      if (response.status === 400 && (await responseIndicatesInputTooLong(response))) {
        throw createInputTooLongError(response.status);
      }
      if (response.status !== 400) {
        await cancelResponseBodySafely(response);
      }
      throw createProviderStatusError(response.status);
    }

    if (!isEventStreamResponse(response)) {
      throw createProtocolError('Provider did not return a text/event-stream response.');
    }

    if (response.body === null) {
      throw createNetworkError('Provider returned an empty streaming response body.');
    }

    return response.body;
  } catch (error) {
    if (error instanceof AgentCodeError) {
      throw error;
    }

    if (isAbortError(error)) {
      if (abortSource === 'caller') {
        throw createCancellationError();
      }

      throw createNetworkError('Provider request timed out before the stream started.');
    }

    throw createNetworkError('Provider network request failed before the stream started.');
  } finally {
    clearTimeout(timeout);
  }
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
}

function createInputTooLongError(status: number): AgentCodeError {
  return new AgentCodeError({
    code: 'provider_error',
    message: 'Provider input too long.',
    retryable: false,
    status,
  });
}

async function cancelResponseBodySafely(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body cleanup must not replace the provider status error.
  }
}

async function responseIndicatesInputTooLong(response: Response): Promise<boolean> {
  const body = await readErrorBodySafely(response);
  if (body === undefined) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) {
    return false;
  }

  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const details = error as { code?: unknown; type?: unknown; message?: unknown };
  if (details.code === 'context_length_exceeded' || details.type === 'context_length_exceeded') {
    return true;
  }

  if (typeof details.message !== 'string') {
    return false;
  }

  return (
    /\bmaximum\s+context\s+length\b/i.test(details.message) ||
    /\bcontext\s+length\s+(?:is\s+)?exceeded\b/i.test(details.message) ||
    /\bprompt\s+(?:is\s+)?too\s+long\b/i.test(details.message) ||
    /\binput\s+(?:is\s+)?too\s+long\b/i.test(details.message)
  );
}

async function readErrorBodySafely(response: Response): Promise<string | undefined> {
  if (response.body === null) {
    return '';
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let totalBytes = 0;
  let body = '';

  try {
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();
        return body;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_ERROR_BODY_BYTES) {
        await cancelReaderSafely(reader);
        return undefined;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (reader !== undefined) {
      await cancelReaderSafely(reader);
    }
    if (isAbortError(error)) {
      throw error;
    }
    return undefined;
  } finally {
    if (reader !== undefined) {
      releaseReaderSafely(reader);
    }
  }
}

async function cancelReaderSafely(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A broken error body must fall back to the generic status error.
  }
}

function releaseReaderSafely(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Reader cleanup must not replace the generic status error.
  }
}

function composeAbortSignals(
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  onAbort: (source: 'timeout' | 'caller') => void,
): AbortSignal {
  if (callerSignal === undefined) {
    return timeoutSignal;
  }

  const controller = new AbortController();
  const abortFromTimeout = () => {
    onAbort('timeout');
    controller.abort();
  };
  const abortFromCaller = () => {
    onAbort('caller');
    controller.abort();
  };

  if (timeoutSignal.aborted) {
    abortFromTimeout();
    return controller.signal;
  }

  if (callerSignal.aborted) {
    abortFromCaller();
    return controller.signal;
  }

  timeoutSignal.addEventListener('abort', abortFromTimeout, { once: true });
  callerSignal.addEventListener('abort', abortFromCaller, { once: true });

  return controller.signal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
