import type { McpTransport } from './transport/types.js';
import type { ToolDefinition } from '../tools/types.js';

/** MCP Server 返回的原始工具描述 */
export interface McpRawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** MCP tools/call 调用结果（已归一化） */
export interface McpCallResult {
  /** content 数组 text 条目拼接；image/resource 用占位符 */
  text: string;
  /** MCP 响应的 isError 字段 */
  isError: boolean;
}

/** McpClient 构造选项 */
export interface McpClientOptions {
  serverName: string;
  transport: McpTransport;
  /** initialize 握手超时（毫秒），默认 10_000 */
  connectTimeoutMs?: number;
}

/** 单个 MCP Server 的连接客户端 */
export interface McpClient {
  /** 执行 initialize 握手，成功后发送 initialized 通知 */
  connect(): Promise<void>;
  /** 发送 tools/list，返回原始工具列表 */
  listTools(): Promise<McpRawTool[]>;
  /** 发送 tools/call，返回归一化结果 */
  callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<McpCallResult>;
  /** 关闭传输连接，停止消息循环 */
  close(): Promise<void>;
}

/** initMcpManager 每个 Server 的初始化结果 */
export interface McpManagerInitResult {
  serverName: string;
  status: 'connected' | 'failed';
  tools: ToolDefinition[];
  /** 失败时的警告摘要（不含完整 stack trace） */
  warning?: string;
}

/** MCP 连接池与工具搜索 */
export interface McpManager {
  /** 所有已连接 Server 的 ToolDefinition 列表 */
  getTools(): readonly ToolDefinition[];
  /** 按关键词搜索工具（名称或描述大小写不敏感子串匹配） */
  searchTools(query: string): ToolDefinition[];
  /** 并发关闭所有连接 */
  closeAll(): Promise<void>;
}
