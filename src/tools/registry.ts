import {
  createEditFileTool,
  createGlobFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createWriteFileTool,
} from './builtins/index.js';
import type { ProviderToolDeclaration, ToolDefinition, ToolRegistry, ToolRisk } from './types.js';

/** 从任意工具列表创建静态 registry */
export function createStaticRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  return new StaticToolRegistry(tools);
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new StaticToolRegistry([
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createRunCommandTool(),
    createGlobFilesTool(),
    createSearchCodeTool(),
  ]);
}

class StaticToolRegistry implements ToolRegistry {
  private readonly tools: readonly ToolDefinition[];
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition>;

  constructor(tools: readonly ToolDefinition[]) {
    this.tools = [...tools];
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  list(): readonly ToolDefinition[] {
    return this.tools;
  }

  get(name: string): ToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  getProviderDeclarations(): ProviderToolDeclaration[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  filterByRisk(allowedRisks: ToolRisk[]): ToolRegistry {
    const allowed = new Set(allowedRisks);
    const filtered = this.tools.filter((tool) => allowed.has(tool.risk));
    return new StaticToolRegistry(filtered);
  }
}

/**
 * 双层工具注册表（F10/F11）。
 *
 * - providerTools：内置工具 + mcp_search_tools，通过 getProviderDeclarations() 暴露给 Provider
 * - hiddenTools：MCP 工具，不出现在 Provider 工具声明列表，但可通过 get() 按名查找
 *
 * Agent 通过 mcp_search_tools 发现 MCP 工具名后，走 get() 路径调用，与内置工具执行流程一致。
 */
class CompositeToolRegistry implements ToolRegistry {
  constructor(
    private readonly providerTools: ToolRegistry,
    private readonly hiddenTools: ReadonlyMap<string, ToolDefinition>,
  ) {}

  list(): readonly ToolDefinition[] {
    return [...this.providerTools.list(), ...this.hiddenTools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.providerTools.get(name) ?? this.hiddenTools.get(name);
  }

  /** 只返回 providerTools 的声明，MCP 工具不暴露给 Provider（AC11） */
  getProviderDeclarations(): ProviderToolDeclaration[] {
    return this.providerTools.getProviderDeclarations();
  }

  filterByRisk(allowedRisks: ToolRisk[]): ToolRegistry {
    const allowed = new Set(allowedRisks);
    const filteredProvider = this.providerTools.filterByRisk(allowedRisks);
    const filteredHidden = new Map(
      [...this.hiddenTools.entries()].filter(([, tool]) => allowed.has(tool.risk)),
    );
    return new CompositeToolRegistry(filteredProvider, filteredHidden);
  }
}

/**
 * 工厂函数：创建 CompositeToolRegistry。
 *
 * @param providerTools 内置工具 registry（含 mcp_search_tools）
 * @param mcpTools MCP 工具 map（key = serverName__toolName）
 */
export function createCompositeRegistry(
  providerTools: ToolRegistry,
  mcpTools: ReadonlyMap<string, ToolDefinition>,
): ToolRegistry {
  return new CompositeToolRegistry(providerTools, mcpTools);
}
