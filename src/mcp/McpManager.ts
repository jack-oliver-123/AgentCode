import type { McpServersConfig, McpServerEntry } from '../config/mcpSchema.js';
import type { ToolDefinition } from '../tools/types.js';
import { createMcpClient } from './McpClient.js';
import { adaptMcpTool } from './McpToolAdapter.js';
import type { McpClient, McpManager, McpManagerInitResult } from './types.js';
import type { McpTransport } from './transport/types.js';

/**
 * 并发初始化所有 MCP Server，构建连接池。
 *
 * 使用 Promise.allSettled 保证单个 Server 失败不阻断整体（N1 失败隔离）。
 * 失败 Server 只记录 warning，不抛出异常。
 */
export async function initMcpManager(
  configs: McpServersConfig,
  createTransport: (entry: McpServerEntry) => McpTransport,
): Promise<{ manager: McpManager; initResults: McpManagerInitResult[] }> {
  const entries = Object.entries(configs);

  const clients: McpClient[] = [];
  const allTools: ToolDefinition[] = [];

  const results = await Promise.allSettled(
    entries.map(async ([serverName, entry]): Promise<McpManagerInitResult> => {
      const transport = createTransport(entry);
      const client = createMcpClient({ serverName, transport });

      await client.connect();
      clients.push(client);
      const rawTools = await client.listTools();

      const tools = rawTools.map((raw) =>
        adaptMcpTool(serverName, raw, (name, args, signal, timeoutMs) =>
          client.callTool(name, args, signal, timeoutMs),
        ),
      );

      return { serverName, status: 'connected', tools };
    }),
  );

  const initResults: McpManagerInitResult[] = results.map((result, index) => {
    const serverName = entries[index]![0];
    if (result.status === 'fulfilled') {
      allTools.push(...result.value.tools);
      return result.value;
    } else {
      const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      const warning = `MCP Server "${serverName}" failed to connect: ${err.message}`;
      console.warn(`[MCP] ${warning}`);
      return { serverName, status: 'failed', tools: [], warning };
    }
  });

  const manager: McpManager = {
    getTools(): readonly ToolDefinition[] {
      return allTools;
    },

    searchTools(query: string): ToolDefinition[] {
      if (query.trim().length === 0) return [];
      const terms = query.trim().toLowerCase().split(/\s+/);
      return allTools.filter((tool) => {
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      });
    },

    async closeAll(): Promise<void> {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };

  return { manager, initResults };
}
