/**
 * MCP 传输层抽象接口。
 * 支持 stdio（子进程管道）和 Streamable HTTP 两种传输实现。
 */
export interface McpTransport {
  /** 发送一条 JSON-RPC 消息字符串 */
  send(message: string): Promise<void>;
  /** 接收消息流，每次 yield 一条完整 JSON 字符串 */
  messages(): AsyncIterable<string>;
  /** 关闭连接，释放资源 */
  close(): Promise<void>;
}
