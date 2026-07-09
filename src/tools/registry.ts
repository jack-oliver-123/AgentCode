import {
  createEditFileTool,
  createGlobFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createWriteFileTool,
} from './builtins/index.js';
import type { ProviderToolDeclaration, ToolDefinition, ToolRegistry, ToolRisk } from './types.js';

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
