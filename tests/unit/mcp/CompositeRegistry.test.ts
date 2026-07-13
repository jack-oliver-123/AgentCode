import { describe, it, expect } from 'vitest';
import { createCompositeRegistry, createDefaultToolRegistry } from '../../../src/tools/registry.js';
import type { ToolDefinition } from '../../../src/tools/types.js';

function makeTool(name: string, risk: ToolDefinition['risk'] = 'read'): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk,
    validate: (i) => ({ ok: true, value: i }),
    execute: async () => ({
      ok: true,
      toolName: name,
      data: '',
      meta: { durationMs: 0, timedOut: false },
    }),
  };
}

describe('CompositeToolRegistry', () => {
  it('getProviderDeclarations 不含 MCP 工具（AC11）', () => {
    const builtins = createDefaultToolRegistry();
    const mcpTool = makeTool('myserver__get_data');
    const hiddenMap = new Map([[mcpTool.name, mcpTool]]);
    const registry = createCompositeRegistry(builtins, hiddenMap);

    const declarations = registry.getProviderDeclarations();
    const names = declarations.map((d) => d.name);
    expect(names).not.toContain('myserver__get_data');
    // 内置工具存在
    expect(names).toContain('read_file');
  });

  it('get() 能查到 hiddenTools 中的 MCP 工具', () => {
    const builtins = createDefaultToolRegistry();
    const mcpTool = makeTool('myserver__get_data');
    const hiddenMap = new Map([[mcpTool.name, mcpTool]]);
    const registry = createCompositeRegistry(builtins, hiddenMap);

    expect(registry.get('myserver__get_data')).toBe(mcpTool);
  });

  it('get() 能查到内置工具', () => {
    const builtins = createDefaultToolRegistry();
    const registry = createCompositeRegistry(builtins, new Map());
    expect(registry.get('read_file')).toBeDefined();
  });

  it('list() 返回两层合并结果', () => {
    const builtins = createDefaultToolRegistry();
    const mcpTool = makeTool('myserver__get_data');
    const hiddenMap = new Map([[mcpTool.name, mcpTool]]);
    const registry = createCompositeRegistry(builtins, hiddenMap);

    const names = registry.list().map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('myserver__get_data');
  });

  it('filterByRisk 两层都过滤，getProviderDeclarations 仍只含 providerTools 侧', () => {
    const builtins = createDefaultToolRegistry();
    const mcpRead = makeTool('s__read_tool', 'read');
    const mcpWrite = makeTool('s__write_tool', 'write');
    const hiddenMap = new Map([
      [mcpRead.name, mcpRead],
      [mcpWrite.name, mcpWrite],
    ]);
    const registry = createCompositeRegistry(builtins, hiddenMap);

    const filtered = registry.filterByRisk(['read']);
    const declarations = filtered.getProviderDeclarations();
    const declNames = declarations.map((d) => d.name);

    // provider 侧只有 read 工具
    expect(declNames).not.toContain('write_file');
    expect(declNames).not.toContain('edit_file');

    // hidden 侧：read MCP 工具可通过 get 找到，write 工具找不到
    expect(filtered.get('s__read_tool')).toBeDefined();
    expect(filtered.get('s__write_tool')).toBeUndefined();
  });

  it('get() 不存在的工具返回 undefined', () => {
    const registry = createCompositeRegistry(createDefaultToolRegistry(), new Map());
    expect(registry.get('nonexistent_tool')).toBeUndefined();
  });
});
