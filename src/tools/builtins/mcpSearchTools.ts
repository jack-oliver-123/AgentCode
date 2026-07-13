import type { McpManager } from '../../mcp/types.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolValidationResult,
} from '../types.js';

/**
 * mcp_search_tools 内置工具。
 *
 * 按关键词搜索 MCP 工具（F10）：
 * - 不预展开进 system prompt，不出现在 Provider 工具声明列表
 * - Agent 通过此工具发现 MCP 工具后，再按名称直接调用
 */
export function createMcpSearchTool(manager: McpManager): ToolDefinition {
  return {
    name: 'mcp_search_tools',
    description:
      'Search for available MCP (Model Context Protocol) tools by keyword. ' +
      'Returns matching tool names, descriptions, and input schemas. ' +
      'Use this before calling an MCP tool to discover what is available.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords to search for (space-separated). ' +
            'Matches against tool name and description (case-insensitive).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    risk: 'read',

    validate(input: unknown): ToolValidationResult<{ query: string }> {
      if (typeof input !== 'object' || input === null) {
        return {
          ok: false,
          error: { code: 'invalid_arguments', message: 'mcp_search_tools: arguments must be an object', retryable: false },
        };
      }
      const args = input as Record<string, unknown>;
      if (typeof args['query'] !== 'string') {
        return {
          ok: false,
          error: { code: 'invalid_arguments', message: 'mcp_search_tools: query must be a string', retryable: false },
        };
      }
      return { ok: true, value: { query: args['query'] } };
    },

    async execute(
      input: { query: string },
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult<string>> {
      const start = Date.now();
      const matches = manager.searchTools(input.query);

      if (matches.length === 0) {
        return {
          ok: true,
          toolName: 'mcp_search_tools',
          data: 'No matching MCP tools found.',
          meta: { durationMs: Date.now() - start, timedOut: false },
        };
      }

      const lines: string[] = [`Found ${matches.length} MCP tool(s):\n`];
      for (const tool of matches) {
        lines.push(`## ${tool.name}`);
        lines.push(`Description: ${tool.description}`);
        lines.push(`Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}`);
        lines.push('');
      }

      return {
        ok: true,
        toolName: 'mcp_search_tools',
        data: lines.join('\n'),
        meta: { durationMs: Date.now() - start, timedOut: false },
      };
    },
  };
}
