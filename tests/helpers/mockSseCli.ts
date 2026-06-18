import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number.parseInt(process.env['AGENTCODE_MOCK_SSE_PORT'] ?? '0', 10);
const CHUNK_DELAY_MS = Number.parseInt(process.env['AGENTCODE_MOCK_SSE_DELAY_MS'] ?? '700', 10);
const URL_FILE = process.env['AGENTCODE_MOCK_SSE_URL_FILE'];
const FIRST_REPLY = 'streammarker first answer';
const SECOND_REPLY = 'I remember first answer.';
const TOOL_FIXTURE_PATH = 'tool-fixture.txt';
const TOOL_FIXTURE_TEXT = 'fixture says tool loop works';
const TOOL_FINAL_REPLY = `Tool summary: ${TOOL_FIXTURE_TEXT}.`;

const server = createServer(async (request, response) => {
  const body = await readRequestBody(request);

  if (request.url?.endsWith('/chat/completions') === true) {
    await writeOpenAIStream(response, body);
    return;
  }

  if (request.url?.endsWith('/messages') === true) {
    await writeAnthropicStream(response, body);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Mock SSE server did not bind to a TCP port.');
  }

  const url = `http://127.0.0.1:${address.port}`;
  if (URL_FILE !== undefined) {
    writeFileSync(URL_FILE, `${url}\n`, 'utf8');
  }

  process.stdout.write(`${url}\n`);
});

process.once('SIGTERM', closeServerAndExit);
process.once('SIGINT', closeServerAndExit);

async function writeOpenAIStream(response: ServerResponse, rawBody: string): Promise<void> {
  response.writeHead(200, streamHeaders());

  if (shouldReturnToolCall(rawBody)) {
    await writeOpenAIToolCall(response);
    return;
  }

  const reply = chooseReply(rawBody);
  const chunks = splitReply(reply);
  for (const [index, chunk] of chunks.entries()) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`);
    if (index < chunks.length - 1) {
      await delay(CHUNK_DELAY_MS);
    }
  }

  response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  response.write('data: [DONE]\n\n');
  response.end();
}

async function writeOpenAIToolCall(response: ServerResponse): Promise<void> {
  response.write(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-read-fixture',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":'
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    })}\n\n`
  );
  await delay(CHUNK_DELAY_MS);
  response.write(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify(TOOL_FIXTURE_PATH) + '}'
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    })}\n\n`
  );
  response.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  response.write('data: [DONE]\n\n');
  response.end();
}

async function writeAnthropicStream(response: ServerResponse, rawBody: string): Promise<void> {
  const reply = chooseReply(rawBody);
  response.writeHead(200, streamHeaders());
  response.write('event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n');

  const chunks = splitReply(reply);
  for (const [index, chunk] of chunks.entries()) {
    response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } })}\n\n`);
    if (index < chunks.length - 1) {
      await delay(CHUNK_DELAY_MS);
    }
  }

  response.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
  response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  response.end();
}

function chooseReply(rawBody: string): string {
  if (hasToolResultContext(rawBody)) {
    return TOOL_FINAL_REPLY;
  }

  return hasSecondTurnContext(rawBody) ? SECOND_REPLY : FIRST_REPLY;
}

function shouldReturnToolCall(rawBody: string): boolean {
  return hasFixtureQuestion(rawBody) && !hasToolResultContext(rawBody);
}

function hasFixtureQuestion(rawBody: string): boolean {
  const messages = parseMessages(rawBody);
  const lastMessage = messages.at(-1);
  return matchesMessage(lastMessage, 'user', 'fixture') && hasTools(rawBody);
}

function hasToolResultContext(rawBody: string): boolean {
  return parseMessages(rawBody).some((message) => isOpenAIToolResultMessage(message) || isAnthropicToolResultMessage(message));
}

function isOpenAIToolResultMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as { role?: unknown; tool_call_id?: unknown; content?: unknown };
  return candidate.role === 'tool' && candidate.tool_call_id === 'call-read-fixture' && includesFixtureText(candidate.content);
}

function isAnthropicToolResultMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== 'user' || !Array.isArray(candidate.content)) {
    return false;
  }

  return candidate.content.some((block) => {
    if (typeof block !== 'object' || block === null) {
      return false;
    }

    const toolResult = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
    return toolResult.type === 'tool_result' && toolResult.tool_use_id === 'call-read-fixture' && includesFixtureText(toolResult.content);
  });
}

function includesFixtureText(content: unknown): boolean {
  return typeof content === 'string' && content.includes(TOOL_FIXTURE_TEXT);
}

function hasSecondTurnContext(rawBody: string): boolean {
  const messages = parseMessages(rawBody);
  if (messages.length < 3) {
    return false;
  }

  const recentMessages = messages.slice(-3);
  return (
    matchesMessage(recentMessages[0], 'user') &&
    matchesMessage(recentMessages[1], 'assistant', FIRST_REPLY) &&
    matchesMessage(recentMessages[2], 'user', 'second')
  );
}

function parseMessages(rawBody: string): unknown[] {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('messages' in parsed)) {
      return [];
    }

    const messages = (parsed as { messages?: unknown }).messages;
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function hasTools(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('tools' in parsed)) {
      return false;
    }

    return Array.isArray((parsed as { tools?: unknown }).tools);
  } catch {
    return false;
  }
}

function matchesMessage(message: unknown, role: string, contentIncludes?: string): boolean {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== role || typeof candidate.content !== 'string') {
    return false;
  }

  return contentIncludes === undefined || candidate.content.toLowerCase().includes(contentIncludes.toLowerCase());
}

function splitReply(reply: string): string[] {
  const midpoint = Math.ceil(reply.length / 2);
  return [reply.slice(0, midpoint), reply.slice(midpoint)];
}

function streamHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  };
}

function closeServerAndExit(): void {
  server.close(() => process.exit(0));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
