import type { McpTransport } from './transport/types.js';

// --- JSON-RPC 2.0 消息类型 ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 消息分发器。
 *
 * 每个 McpClient 创建一个实例（id 计数器和 pending map 均 per-instance）。
 * McpClient 负责启动**单一共享消息循环**，每收到一条消息调用 dispatch() 路由到
 * 对应的 pending 项。sendRequest 本身不启动监听循环。
 */
export class JsonRpcDispatcher {
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();

  /**
   * 发送 JSON-RPC 请求并等待响应。
   * id 由实例内部递增生成，保证 per-instance 唯一。
   */
  async sendRequest(
    transport: McpTransport,
    method: string,
    params?: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = this.nextId++;

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      // 提前检查 signal 是否已经 abort
      if (signal?.aborted) {
        reject(new Error(`MCP request '${method}' was aborted`));
        return;
      }

      const entry: PendingEntry = { resolve, reject };

      // 超时定时器
      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

      // abort 信号监听
      const onAbort = (): void => {
        if (this.pending.delete(id)) {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          reject(new Error(`MCP request '${method}' was aborted`));
        }
      };
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, entry);

      // 发送请求；transport.send 失败时 reject 并清理
      transport.send(JSON.stringify(request)).catch((err: unknown) => {
        if (this.pending.delete(id)) {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * 发送 JSON-RPC 通知（无 id，不等待响应）。
   */
  async sendNotification(
    transport: McpTransport,
    method: string,
    params?: unknown,
  ): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await transport.send(JSON.stringify(notification));
  }

  /**
   * 路由一条从 transport 接收到的原始消息字符串。
   * 由 McpClient 的共享消息循环调用，每条消息调用一次。
   */
  dispatch(rawMessage: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      // 无法解析的消息静默丢弃
      return;
    }

    if (!isJsonRpcResponse(parsed)) {
      // 通知或其他非请求-响应消息，暂不处理
      return;
    }

    const entry = this.pending.get(parsed.id);
    if (entry === undefined) {
      // 未知 id 静默丢弃
      return;
    }

    this.pending.delete(parsed.id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);

    if (isJsonRpcError(parsed)) {
      entry.reject(new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`));
    } else {
      entry.resolve(parsed.result);
    }
  }

  /**
   * 批量 reject 所有未完成的 pending 请求。
   * 在 transport 关闭或意外断开时调用，防止调用方永久挂起。
   */
  rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /** 当前 pending 请求数（供测试验证） */
  get pendingCount(): number {
    return this.pending.size;
  }
}

// --- 类型守卫 ---

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['jsonrpc'] === '2.0' &&
    typeof (value as Record<string, unknown>)['id'] === 'number'
  );
}

function isJsonRpcError(response: JsonRpcResponse): response is JsonRpcError {
  return 'error' in response;
}
