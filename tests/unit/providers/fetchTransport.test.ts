import { describe, expect, it, vi } from 'vitest';

import { fetchJsonStream } from '../../../src/providers/shared/fetchTransport.js';
import { AgentCodeError } from '../../../src/shared/errors.js';

const encoder = new TextEncoder();

describe('fetchJsonStream', () => {
  it('sends JSON requests and returns the streaming response body', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: hello\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      }),
    );

    const stream = await fetchJsonStream(
      {
        url: 'https://api.example.com/v1/chat/completions',
        headers: {
          authorization: 'Bearer test-key',
        },
        body: {
          stream: true,
        },
      },
      {
        fetch: fetchMock,
        timeoutMs: 1000,
      },
    );

    expect(stream).toBe(body);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: 'Bearer test-key',
        }),
        body: '{"stream":true}',
      }),
    );
  });

  it.each([
    [401, 'auth_error', false],
    [403, 'auth_error', false],
    [429, 'rate_limit', true],
    [500, 'provider_error', true],
    [400, 'provider_error', false],
  ])('maps HTTP %s to a public provider error', async (status, code, retryable) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad', { status }));

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {},
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({
      publicError: {
        code,
        retryable,
        status,
      },
    });
  });

  it.each([
    [
      400,
      {
        error: {
          code: 'context_length_exceeded',
          type: 'invalid_request_error',
          message: 'maximum context length exceeded: PRIVATE_USER_CONTENT',
        },
      },
    ],
    [
      400,
      {
        error: {
          type: 'invalid_request_error',
          message: "This model's maximum context length is exceeded: PRIVATE_USER_CONTENT",
        },
      },
    ],
    [
      413,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: PRIVATE_USER_CONTENT',
        },
      },
    ],
    [
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'input too long: PRIVATE_USER_CONTENT',
        },
      },
    ],
  ])('normalizes HTTP %s input-length bodies without leaking the raw body', async (status, body) => {
    const rawBody = JSON.stringify(body);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(rawBody, {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

    let caught: unknown;
    try {
      await fetchJsonStream(
        { url: 'https://api.example.com/v1/messages', body: {} },
        { fetch: fetchMock, timeoutMs: 1000 },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentCodeError);
    expect(caught).toMatchObject({
      publicError: {
        code: 'provider_error',
        message: 'Provider input too long.',
        retryable: false,
        status,
      },
    });
    const publicMessage = (caught as AgentCodeError).publicError.message;
    expect(publicMessage).not.toContain('PRIVATE_USER_CONTENT');
    expect(publicMessage).not.toContain(rawBody);
  });

  it.each([
    {
      error: {
        code: 'invalid_request_error',
        message: 'maximum output tokens exceeded',
      },
    },
    {
      error: {
        code: 'rate_limit_exceeded',
        message: 'maximum tokens per minute exceeded',
      },
    },
    {
      error: {
        code: 'invalid_request_error',
        message: 'ordinary malformed request',
      },
    },
  ])('does not misclassify a non-length HTTP 400 body: %j', async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      fetchJsonStream({ url: 'https://api.example.com/v1/messages', body: {} }, { fetch: fetchMock, timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      publicError: {
        code: 'provider_error',
        message: 'Provider request failed with HTTP 400.',
        retryable: false,
        status: 400,
      },
    });
  });

  it('rejects successful responses that are not event streams', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"error":"not a stream"}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {},
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({
      publicError: {
        code: 'protocol_error',
        retryable: false,
      },
    });
  });

  it('maps an empty response body to a retryable network error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      }),
    );

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {},
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: true,
      },
    });
  });

  it('maps fetch failures to retryable network errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {},
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: true,
      },
    });
  });

  it('maps caller aborts to non-retryable cancellation errors', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {},
          signal: abortController.signal,
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: false,
      },
    });
  });

  it('keeps caller abort non-retryable even when fetch rejects after timeout fires', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    abortController.abort();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 20);
        }),
    );

    try {
      const assertion = expect(
        fetchJsonStream(
          {
            url: 'https://api.example.com/v1/messages',
            body: {},
            signal: abortController.signal,
          },
          {
            fetch: fetchMock,
            timeoutMs: 10,
          },
        ),
      ).rejects.toMatchObject({
        publicError: {
          code: 'network_error',
          retryable: false,
        },
      });

      await vi.advanceTimersByTimeAsync(20);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps timeout aborts to retryable network errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {},
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: true,
      },
    });
  });
});
