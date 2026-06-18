import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { executeToolCall } from '../../../src/tools/executor.js';
import type { ProviderToolCall, ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolRegistry } from '../../../src/tools/types.js';

export async function createWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'agentcode-file-tools-')));
}

export async function writeWorkspaceFile(workspace: string, path: string, content: string | Buffer): Promise<string> {
  const absolutePath = join(workspace, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}

export async function readWorkspaceFile(workspace: string, path: string): Promise<string> {
  return readFile(join(workspace, path), 'utf8');
}

export async function executeFileTool(
  tool: ToolDefinition,
  argumentsText: string,
  context: Partial<ToolExecutionContext> & { cwd: string }
): Promise<ToolExecutionResult> {
  return executeToolCall(createCall(tool.name, argumentsText), createRegistry([tool]), {
    timeoutMs: 100,
    secrets: [],
    maxOutputBytes: 1024,
    ...context
  });
}

function createCall(name: string, argumentsText: string): ProviderToolCall {
  return {
    id: `call-${name}`,
    name,
    argumentsText
  };
}

function createRegistry(tools: ToolDefinition[]): ToolRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    list: () => tools,
    get: (name: string) => toolsByName.get(name),
    getProviderDeclarations: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
  };
}
