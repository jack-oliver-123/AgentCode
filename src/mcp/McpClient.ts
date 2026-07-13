import { JsonRpcDispatcher } from './jsonrpc.js';
import type { McpCallResult, McpClient, McpClientOptions, McpRawTool } from './types.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * 单 MCP Server 连接客户端。
 *
 * 启动一个共享消息分发循环（单循环架构），由 JsonRpcDispatcher 按 id 路由响应。
 * transport 意外关闭时，批量 reject 所有 pending 请求，不产生 Unhandled Promise Rejection。
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const { transport, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = options;
  const dispatcher = new JsonRpcDispatcher();
  let loopStopped = false;
  let loopPromise: Promise<void> | undefined;

  /**
   * 启动共享消息分发循环。
   * 必须在 connect() 中调用，保证在发送任何请求之前循环已就绪。
   */
  function startMessageLoop(): void {
    loopPromise = (async () => {
      try {
        for await (const message of transport.messages()) {
          if (loopStopped) break;
          dispatcher.dispatch(message);
        }
      } catch (err) {
        // transport 意外关闭，不产生 Unhandled Promise Rejection
        const error = err instanceof Error ? err : new Error(String(err));
        dispatcher.rejectAll(error);
        return;
      }
      // 正常结束（transport.close() 后 messages() 迭代器退出）
      dispatcher.rejectAll(new Error('MCP transport closed'));
    })();
  }

  return {
    async connect(): Promise<void> {
      // 先启动消息循环，再发请求，避免响应在监听前到达被丢弃
      startMessageLoop();

      try {
        await dispatcher.sendRequest(
          transport,
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            clientInfo: { name: 'agentcode', version: '0.1' },
            capabilities: {},
          },
          undefined,
          connectTimeoutMs,
        );

        // initialized 是通知（无 id），不等待响应
        await dispatcher.sendNotification(transport, 'notifications/initialized');
      } catch (err) {
        // 握手失败时清理消息循环和 transport，避免后台循环泄露（Issue #50）
        loopStopped = true;
        await transport.close().catch(() => {});
        if (loopPromise !== undefined) {
          await loopPromise.catch(() => {});
        }
        throw err;
      }
    },

    async listTools(): Promise<McpRawTool[]> {
      const result = await dispatcher.sendRequest(transport, 'tools/list');
      const tools = (result as Record<string, unknown>)['tools'];
      if (!Array.isArray(tools)) return [];
      return tools as McpRawTool[];
    },

    async callTool(
      name: string,
      args: unknown,
      signal?: AbortSignal,
      timeoutMs?: number,
    ): Promise<McpCallResult> {
      const result = await dispatcher.sendRequest(
        transport,
        'tools/call',
        { name, arguments: args },
        signal,
        timeoutMs,
      );

      const raw = result as Record<string, unknown>;
      const content = Array.isArray(raw['content']) ? raw['content'] : [];
      const isError = raw['isError'] === true;

      // 归一化 content 数组
      const text = (content as unknown[])
        .map((item) => {
          if (typeof item !== 'object' || item === null) return '';
          const c = item as Record<string, unknown>;
          if (c['type'] === 'text') return typeof c['text'] === 'string' ? c['text'] : '';
          if (c['type'] === 'image') return '[image]';
          if (c['type'] === 'resource') return '[resource]';
          return '';
        })
        .filter((s) => s.length > 0)
        .join('\n');

      return { text, isError };
    },

    async close(): Promise<void> {
      loopStopped = true;
      await transport.close();
      // 等待消息循环退出
      if (loopPromise !== undefined) {
        await loopPromise.catch(() => {
          // 忽略循环退出时的错误
        });
      }
    },
  };
}
