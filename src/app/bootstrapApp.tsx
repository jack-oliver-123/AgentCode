import { type Instance, render } from 'ink';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type React from 'react';

import type { McpServerEntry } from '../config/mcpSchema.js';
import { type LoadConfigOptions, loadConfig } from '../config/loadConfig.js';
import { initMcpManager } from '../mcp/McpManager.js';
import { createHttpTransport } from '../mcp/transport/HttpTransport.js';
import { createStdioTransport } from '../mcp/transport/StdioTransport.js';
import type { McpTransport } from '../mcp/transport/types.js';
import { createProvider } from '../providers/createProvider.js';
import { AutoNoteWriter, type AutoNoteWriterOptions, type AutoNoteWriterPort } from '../notes/AutoNoteWriter.js';
import {
  ChatSessionController,
  type ChatSessionControllerOptions,
} from '../session/ChatSessionController.js';
import {
  SessionArchive,
  type SessionArchiveOptions,
  type SessionArchivePort,
} from '../session/SessionArchive.js';
import { maybeClean, type SessionCleanerOptions } from '../session/SessionCleaner.js';
import { pickSession } from '../session/ResumeSelector.js';
import { loadDynamicModules } from '../system-prompt/index.js';
import { createMcpSearchTool } from '../tools/builtins/mcpSearchTools.js';
import {
  createDefaultToolRegistry,
  createCompositeRegistry,
  createStaticRegistry,
} from '../tools/registry.js';
import {
  createEditFileTool,
  createGlobFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createWriteFileTool,
} from '../tools/builtins/index.js';
import { App } from '../tui/App.js';
import { createPermissionPromptCoordinator } from '../tui/permissionPromptCoordinator.js';

export type RenderApp = (node: React.ReactNode) => Instance;

export interface BootstrapAppOptions extends LoadConfigOptions {
  fetch?: typeof fetch;
  renderApp?: RenderApp;
  resumeMode?: boolean;
}

export interface BootstrapDependencies {
  loadDynamicModules?: typeof loadDynamicModules;
  pickSession?: typeof pickSession;
  maybeClean?: (cwd: string, options?: SessionCleanerOptions) => Promise<void>;
  createSessionArchive?: (options: SessionArchiveOptions) => SessionArchivePort;
  createAutoNoteWriter?: (options: AutoNoteWriterOptions) => AutoNoteWriterPort;
  createController?: (options: ChatSessionControllerOptions) => ChatSessionController;
}

/** 根据 McpServerEntry 类型创建对应的 transport */
function createDefaultTransport(entry: McpServerEntry): McpTransport {
  if (entry.type === 'stdio') {
    return createStdioTransport(entry);
  }
  return createHttpTransport(entry);
}

export async function bootstrapApp(
  options: BootstrapAppOptions = {},
  dependencies: BootstrapDependencies = {},
): Promise<Instance> {
  const { cwd, fetch, homeDir, renderApp = render } = options;
  const loadModules = dependencies.loadDynamicModules ?? loadDynamicModules;
  const selectSession = dependencies.pickSession ?? pickSession;
  const cleanSessions = dependencies.maybeClean ?? maybeClean;
  const createArchive = dependencies.createSessionArchive ?? ((archiveOptions) => new SessionArchive(archiveOptions));
  const createNoteWriter =
    dependencies.createAutoNoteWriter ?? ((writerOptions) => new AutoNoteWriter(writerOptions));
  const createController = dependencies.createController ?? ((controllerOptions) => new ChatSessionController(controllerOptions));
  const runtimeCwd = cwd ?? process.cwd();
  const runtimeHomeDir = homeDir ?? homedir();
  const resolvedConfig = await loadConfig({
    cwd: runtimeCwd,
    homeDir: runtimeHomeDir,
  });
  const provider = createProvider({
    config: resolvedConfig.config,
    ...(fetch !== undefined ? { fetch } : {}),
  });
  const projectRoot = resolvedConfig.source === 'project' ? dirname(dirname(resolvedConfig.path)) : runtimeCwd;

  const registryPromise = loadModules(projectRoot, runtimeHomeDir);
  void cleanSessions(projectRoot).catch((error) => {
    console.warn('[SessionCleaner] 后台清理失败', error);
  });
  const restoredSession = options.resumeMode === true ? await selectSession(projectRoot) : null;
  const systemPromptRegistry = await registryPromise;
  const permissionPromptCoordinator = createPermissionPromptCoordinator();

  // MCP 集成：有 mcpServers 配置时初始化连接池，否则使用默认 registry（条件门控）
  const mcpServers = resolvedConfig.config.mcpServers;
  let toolRegistry = createDefaultToolRegistry();

  if (mcpServers !== undefined && Object.keys(mcpServers).length > 0) {
    const { manager } = await initMcpManager(mcpServers, createDefaultTransport);

    // SIGINT/SIGTERM 清理：'exit' 事件是同步的，不能执行异步操作，必须用信号处理
    const cleanup = (): void => {
      manager.closeAll().catch(() => {
        // 关闭失败静默忽略
      });
    };
    process.once('SIGINT', () => {
      cleanup();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      cleanup();
      process.exit(143);
    });

    // providerTools：内置工具 + mcp_search_tools（暴露给 Provider 和 system prompt）
    const mcpSearchTool = createMcpSearchTool(manager);
    const providerTools = createStaticRegistry([
      createReadFileTool(),
      createWriteFileTool(),
      createEditFileTool(),
      createRunCommandTool(),
      createGlobFilesTool(),
      createSearchCodeTool(),
      mcpSearchTool,
    ]);

    // hiddenTools：MCP 工具（不出现在 Provider 声明列表，仅通过 get() 按名查找）
    const hiddenMap = new Map(manager.getTools().map((t) => [t.name, t]));
    toolRegistry = createCompositeRegistry(providerTools, hiddenMap);
  }

  const sessionArchive = createArchive({
    sessionsDir: join(projectRoot, '.agentcode', 'sessions'),
    ...(restoredSession?.source !== undefined
      ? {
          resume: {
            sessionId: restoredSession.source.sessionId,
            ...(restoredSession.source.repairOffset !== undefined
              ? {
                  repairOffset: restoredSession.source.repairOffset,
                  expectedFile: restoredSession.source.expectedFile,
                }
              : {}),
          },
        }
      : {}),
  });
  const autoNoteWriter = createNoteWriter({
    provider,
    model: resolvedConfig.config.model,
    timeoutMs: resolvedConfig.config.request.timeoutMs,
    cwd: projectRoot,
    homeDir: runtimeHomeDir,
  });
  const controller = createController({
    provider,
    config: resolvedConfig.config,
    toolRegistry,
    cwd: runtimeCwd,
    toolTimeoutMs: resolvedConfig.config.request.timeoutMs,
    systemPromptRegistry,
    askPermission: permissionPromptCoordinator.askPermission,
    homeDir: runtimeHomeDir,
    sessionArchive,
    autoNoteWriter,
    ...(restoredSession !== null
      ? {
          initialProviderContext: restoredSession.providerContext,
          initialMessages: restoredSession.messages,
        }
      : {}),
  });

  return renderApp(
    <App
      controller={controller}
      resolvedConfig={resolvedConfig}
      cwd={runtimeCwd}
      permissionPromptCoordinator={permissionPromptCoordinator}
    />,
  );
}
