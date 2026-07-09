import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

export interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface MockSseResponse {
  status?: number;
  headers?: Record<string, string>;
  chunks: string[];
  end?: boolean;
}

export interface MockSseServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

export async function createMockSseServer(response: MockSseResponse): Promise<MockSseServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, serverResponse) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });

    writeSseResponse(serverResponse, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Mock SSE server did not bind to a TCP port.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function writeSseResponse(serverResponse: ServerResponse, response: MockSseResponse): void {
  serverResponse.writeHead(response.status ?? 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...response.headers,
  });

  for (const chunk of response.chunks) {
    serverResponse.write(chunk);
  }

  if (response.end ?? true) {
    serverResponse.end();
  }
}
