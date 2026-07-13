import type { McpTransport } from './types.js';

interface HttpServerEntry {
  url: string;
  /** 已展开 ${VAR} 后的请求头键值对 */
  headers: Record<string, string>;
}

/**
 * Streamable HTTP 传输层。
 *
 * 每次 send() 向 url 发送 POST 请求，请求体为 JSON-RPC 消息字符串。
 * messages() 读取响应体，按行 yield（Streamable HTTP 规范：每行一条 JSON-RPC 消息）。
 *
 * 注意：HTTP 无长连接，close() 为 no-op。
 * messages() 会在每次 send() 后产出该请求的响应行。
 * 因为 MCP HTTP 传输是请求-响应模型，调用方（McpClient 消息循环）需正确处理。
 */
export function createHttpTransport(entry: HttpServerEntry): McpTransport {
  let closed = false;

  // 消息队列：POST 响应行 push 进来等待 messages() 消费
  const messageQueue: string[] = [];
  const waiters: Array<() => void> = [];

  function enqueueMessage(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    messageQueue.push(trimmed);
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter();
  }

  return {
    async send(message: string): Promise<void> {
      if (closed) {
        throw new Error('HttpTransport: connection is closed');
      }

      const response = await fetch(entry.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...entry.headers,
        },
        body: message,
      });

      if (!response.ok) {
        throw new Error(`HttpTransport: HTTP ${response.status} ${response.statusText}`);
      }

      if (response.body === null) {
        return;
      }

      // 读取响应体，按行分割，每行 enqueue
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // 最后一段可能不完整，留在 buffer
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            enqueueMessage(line);
          }
        }
        // flush 剩余
        if (buffer.trim().length > 0) {
          enqueueMessage(buffer);
        }
      } finally {
        reader.releaseLock();
      }
    },

    async *messages(): AsyncIterable<string> {
      while (true) {
        while (messageQueue.length > 0) {
          yield messageQueue.shift()!;
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // HTTP 无长连接，唤醒等待者让迭代器退出
      for (const waiter of waiters.splice(0)) waiter();
    },
  };
}
