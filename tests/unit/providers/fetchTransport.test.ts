import { describe, expect, it, vi } from 'vitest';

import { fetchJsonStream } from '../../../src/providers/shared/fetchTransport.js';

const encoder = new TextEncoder();

describe('fetchJsonStream', () => {
  it('sends JSON requests and returns the streaming response body', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: hello\n\n'));
        controller.close();
      }
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream'
        }
      })
    );

    const stream = await fetchJsonStream(
      {
        url: 'https://api.example.com/v1/chat/completions',
        headers: {
          authorization: 'Bearer test-key'
        },
        body: {
          stream: true
        }
      },
      {
        fetch: fetchMock,
        timeoutMs: 1000
      }
    );

    expect(stream).toBe(body);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: 'Bearer test-key'
        }),
        body: '{"stream":true}'
      })
    );
  });

  it.each([
    [401, 'auth_error', false],
    [403, 'auth_error', false],
    [429, 'rate_limit', true],
    [500, 'provider_error', true],
    [400, 'provider_error', false]
  ])('maps HTTP %s to a public provider error', async (status, code, retryable) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad', { status }));

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {}
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      publicError: {
        code,
        retryable,
        status
      }
    });
  });

  it('rejects successful responses that are not event streams', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"error":"not a stream"}', {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      })
    );

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {}
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      publicError: {
        code: 'protocol_error',
        retryable: false
      }
    });
  });

  it('maps an empty response body to a retryable network error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream'
        }
      })
    );

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {}
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: true
      }
    });
  });

  it('maps fetch failures to retryable network errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fetchJsonStream(
        {
          url: 'https://api.example.com/v1/messages',
          body: {}
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: true
      }
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
          signal: abortController.signal
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: false
      }
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
        })
    );

    try {
      const assertion = expect(
        fetchJsonStream(
          {
            url: 'https://api.example.com/v1/messages',
            body: {},
            signal: abortController.signal
          },
          {
            fetch: fetchMock,
            timeoutMs: 10
          }
        )
      ).rejects.toMatchObject({
        publicError: {
          code: 'network_error',
          retryable: false
        }
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
          body: {}
        },
        {
          fetch: fetchMock,
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      publicError: {
        code: 'network_error',
        retryable: true
      }
    });
  });
});
