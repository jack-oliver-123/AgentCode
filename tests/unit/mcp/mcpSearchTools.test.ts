import { describe, it, expect } from 'vitest';
import { createMcpSearchTool } from '../../../src/tools/builtins/mcpSearchTools.js';
import type { McpManager } from '../../../src/mcp/types.js';
import type { ToolDefinition } from '../../../src/tools/types.js';

function makeTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    validate: (i) => ({ ok: true, value: i }),
    execute: async () => ({
      ok: true,
      toolName: name,
      data: '',
      meta: { durationMs: 0, timedOut: false },
    }),
  };
}

function makeManager(tools: ToolDefinition[]): McpManager {
  return {
    getTools: () => tools,
    searchTools: (query: string) => {
      if (query.trim().length === 0) return [];
      const terms = query.trim().toLowerCase().split(/\s+/);
      return tools.filter((t) => {
        const hay = `${t.name} ${t.description}`.toLowerCase();
        return terms.some((term) => hay.includes(term));
      });
    },
    closeAll: async () => {},
  };
}

const context = {
  cwd: '/tmp',
  timeoutMs: 5000,
  secrets: [],
  maxOutputBytes: 10000,
};

describe('mcp_search_tools', () => {
  it('返回匹配工具的名称、描述和 schema', async () => {
    const tools = [
      makeTool('github__list_repos', 'List GitHub repositories'),
      makeTool('github__create_issue', 'Create a new issue'),
      makeTool('fs__read_file', 'Read file contents'),
    ];
    const searchTool = createMcpSearchTool(makeManager(tools));

    const result = await searchTool.execute({ query: 'file' }, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain('fs__read_file');
      expect(result.data).toContain('Read file contents');
      expect(result.data).not.toContain('list_repos');
    }
  });

  it('无匹配时返回空提示，不报错', async () => {
    const searchTool = createMcpSearchTool(makeManager([]));
    const result = await searchTool.execute({ query: 'zzznomatch' }, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain('No matching');
  });

  it('query 为空字符串时返回无结果提示', async () => {
    const tools = [makeTool('tool__foo', 'Foo tool')];
    const searchTool = createMcpSearchTool(makeManager(tools));
    const result = await searchTool.execute({ query: '' }, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain('No matching');
  });

  it('多词查询：任一词命中即纳入', async () => {
    const tools = [
      makeTool('github__list_repos', 'List GitHub repositories'),
      makeTool('fs__read_file', 'Read file contents'),
    ];
    const searchTool = createMcpSearchTool(makeManager(tools));
    const result = await searchTool.execute({ query: 'file repo' }, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain('list_repos');
      expect(result.data).toContain('read_file');
    }
  });

  it('validate 拒绝缺少 query 字段', () => {
    const searchTool = createMcpSearchTool(makeManager([]));
    const result = searchTool.validate({});
    expect(result.ok).toBe(false);
  });

  it('risk 为 read', () => {
    const searchTool = createMcpSearchTool(makeManager([]));
    expect(searchTool.risk).toBe('read');
  });
});
