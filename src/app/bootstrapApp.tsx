import { type Instance, render } from 'ink';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type React from 'react';

import { CommandCompletionService } from '../commands/completion.js';
import { CommandContextBuilder } from '../commands/context.js';
import { CommandDispatcher } from '../commands/dispatcher.js';
import { CommandParser } from '../commands/parser.js';
import { createBuiltinCommandRegistry } from '../commands/builtins/index.js';
import type { McpServerEntry } from '../config/mcpSchema.js';
import { type LoadConfigOptions, loadConfig } from '../config/loadConfig.js';
import { initMcpManager } from '../mcp/McpManager.js';
import { createHttpTransport } from '../mcp/transport/HttpTransport.js';
import { createStdioTransport } from '../mcp/transport/StdioTransport.js';
import type { McpTransport } from '../mcp/transport/types.js';
import type { McpManagerInitResult } from '../mcp/types.js';
import { AutoNoteWriter, type AutoNoteWriterOptions, type AutoNoteWriterPort } from '../notes/AutoNoteWriter.js';
import { createProvider } from '../providers/createProvider.js';
import { ChatSessionController, type ChatSessionControllerOptions } from '../session/ChatSessionController.js';
import { SessionArchive, type SessionArchiveOptions, type SessionArchivePort } from '../session/SessionArchive.js';
import { maybeClean, type SessionCleanerOptions } from '../session/SessionCleaner.js';
import { pickSession } from '../session/ResumeSelector.js';
import { loadDynamicModules } from '../system-prompt/index.js';
import { getGitContext } from '../system-prompt/getGitContext.js';
import { createMcpSearchTool } from '../tools/builtins/mcpSearchTools.js';
import {
  createEditFileTool,
  createGlobFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createWriteFileTool,
} from '../tools/builtins/index.js';
import { createCompositeRegistry, createDefaultToolRegistry, createStaticRegistry } from '../tools/registry.js';
import { App } from '../tui/App.js';
import { createPermissionPromptCoordinator } from '../tui/permissionPromptCoordinator.js';
import { InteractionCoordinator, type InteractionRequest } from './interaction/InteractionCoordinator.js';
import {
  MemoryManager,
  memoryDeleteFingerprint,
  type MemoryIndexSnapshot,
} from './memory/MemoryManager.js';
import { PermissionManager, type PermissionRuleView } from './permissions/PermissionManager.js';
import { ReviewRunner, type ReviewRunnerOptions } from './review/ReviewRunner.js';
import { freezeReviewTarget, validateFrozenReviewTarget } from './review/targetFreeze.js';
import { AppCommandExecutor } from './runtime/AppCommandExecutor.js';
import { AppRuntime } from './runtime/AppRuntime.js';
import { AppSessionRuntime, type RuntimeSessionController } from './runtime/AppSessionRuntime.js';
import { InputRouter } from './runtime/InputRouter.js';
import { SessionWorkspace, type WorkspaceSessionSummary } from './session/SessionWorkspace.js';
import { StatusService } from './status/StatusService.js';

export type RenderApp = (node: React.ReactNode) => Instance;

export interface BootstrapAppOptions extends LoadConfigOptions {
  fetch?: typeof fetch;
  renderApp?: RenderApp;
  resumeMode?: boolean;
}

export interface BootstrapDependencies {
  createCommandRegistry?: typeof createBuiltinCommandRegistry;
  loadDynamicModules?: typeof loadDynamicModules;
  pickSession?: typeof pickSession;
  maybeClean?: (cwd: string, options?: SessionCleanerOptions) => Promise<void>;
  createSessionArchive?: (options: SessionArchiveOptions) => SessionArchivePort;
  createAutoNoteWriter?: (options: AutoNoteWriterOptions) => AutoNoteWriterPort;
  createController?: (options: ChatSessionControllerOptions) => RuntimeSessionController;
  createReviewRunner?: (options: ReviewRunnerOptions) => ReviewRunner;
  freezeReviewTarget?: typeof freezeReviewTarget;
}

function createDefaultTransport(entry: McpServerEntry): McpTransport {
  return entry.type === 'stdio' ? createStdioTransport(entry) : createHttpTransport(entry);
}

export async function bootstrapApp(
  options: BootstrapAppOptions = {},
  dependencies: BootstrapDependencies = {},
): Promise<Instance> {
  const { cwd, fetch, homeDir, renderApp = render } = options;
  const runtimeCwd = cwd ?? process.cwd();
  const runtimeHomeDir = homeDir ?? homedir();
  const resolvedConfig = await loadConfig({ cwd: runtimeCwd, homeDir: runtimeHomeDir });
  const projectRoot = resolvedConfig.source === 'project' ? dirname(dirname(resolvedConfig.path)) : runtimeCwd;
  const provider = createProvider({
    config: resolvedConfig.config,
    ...(fetch !== undefined ? { fetch } : {}),
  });

  const loadModules = dependencies.loadDynamicModules ?? loadDynamicModules;
  const selectSession = dependencies.pickSession ?? pickSession;
  const cleanSessions = dependencies.maybeClean ?? maybeClean;
  const createArchive = dependencies.createSessionArchive ?? ((archiveOptions) => new SessionArchive(archiveOptions));
  const createNoteWriter = dependencies.createAutoNoteWriter ?? ((writerOptions) => new AutoNoteWriter(writerOptions));
  const createController = dependencies.createController ?? ((controllerOptions) => new ChatSessionController(controllerOptions));
  const createReviewRunner = dependencies.createReviewRunner ?? ((reviewOptions) => new ReviewRunner(reviewOptions));

  const commandRegistry = (dependencies.createCommandRegistry ?? createBuiltinCommandRegistry)();
  const modulesPromise = loadModules(projectRoot, runtimeHomeDir);
  void cleanSessions(projectRoot).catch((error) => console.warn('[SessionCleaner] 后台清理失败', error));
  const restoredSession = options.resumeMode === true ? await selectSession(projectRoot) : null;
  const systemPromptRegistry = await modulesPromise;
  const permissionPromptCoordinator = createPermissionPromptCoordinator();

  const mcp = await createToolEnvironment(resolvedConfig.config.mcpServers, permissionPromptCoordinator.dispose);
  const autoNoteWriter = resolvedConfig.config.autoNotesEnabled
    ? createNoteWriter({
        provider,
        model: resolvedConfig.config.model,
        timeoutMs: resolvedConfig.config.request.timeoutMs,
        cwd: projectRoot,
        homeDir: runtimeHomeDir,
      })
    : undefined;

  const runtimeRef: { current?: AppRuntime } = {};
  const permissionManagerRef: { current?: PermissionManager } = {};
  let latestRules: readonly PermissionRuleView[] = [];
  const initialAgentMode = 'default' as const;
  const permissionManager = await PermissionManager.open({
    selectedMode: resolvedConfig.config.permissionMode,
    agentMode: initialAgentMode,
    cwd: projectRoot,
    homeDir: runtimeHomeDir,
    askPermission: permissionPromptCoordinator.askPermission,
    onAudit: async (event) => {
      runtimeRef.current?.dispatch({
        type: 'audit.appended',
        event: {
          id: `permission-${event.generation}-${event.createdAt}`,
          operation: event.operation,
          createdAt: event.createdAt,
          data: { ...event },
        },
      });
      const manager = permissionManagerRef.current;
      if (manager !== undefined) {
        runtimeRef.current?.dispatch({ type: 'permission.changed', permissions: manager.snapshot() });
        latestRules = await manager.getRuleViews();
      }
    },
  });
  permissionManagerRef.current = permissionManager;

  const workspace = await SessionWorkspace.open<RuntimeSessionController>({
    storageRoot: projectRoot,
    selectedPermissionMode: resolvedConfig.config.permissionMode,
    createController: ({ session, restored }) => {
      const sessionArchive = createArchive({
        sessionsDir: join(projectRoot, '.agentcode', 'sessions'),
        resume: {
          sessionId: session.id,
          ...(restored?.source?.repairOffset !== undefined && restored.source.expectedFile !== undefined
            ? { repairOffset: restored.source.repairOffset, expectedFile: restored.source.expectedFile }
            : {}),
        },
      });
      return createController({
        provider,
        config: resolvedConfig.config,
        toolRegistry: mcp.toolRegistry,
        cwd: runtimeCwd,
        toolTimeoutMs: resolvedConfig.config.request.timeoutMs,
        systemPromptRegistry,
        askPermission: permissionPromptCoordinator.askPermission,
        expireApprovals: () => permissionPromptCoordinator.expireAll(),
        homeDir: runtimeHomeDir,
        sessionArchive,
        agentMode: session.agentMode,
        permissionMode: session.selectedPermissionMode,
        permissionManager,
        ...(autoNoteWriter !== undefined ? { autoNoteWriter } : {}),
        ...(restored !== undefined
          ? {
              initialProviderContext: restored.providerContext,
              initialMessages: restored.messages,
              ...(restored.activities !== undefined ? { initialActivities: restored.activities } : {}),
            }
          : {}),
      });
    },
    ...(restoredSession !== null ? { initial: { restored: restoredSession } } : {}),
  });

  await permissionManager.activateSession(workspace.getActiveSnapshot().id);
  await permissionManager.setSelectedMode(workspace.getActiveSnapshot().selectedPermissionMode, { confirmed: true });
  await permissionManager.setModeCap({ agentMode: workspace.getActiveSnapshot().agentMode, reviewActive: false });

  const appRuntime = new AppRuntime({
    mode: workspace.getActiveSnapshot().agentMode,
    session: workspace.getActiveSnapshot(),
    queue: toRuntimeQueue(workspace),
    permissions: permissionManager.snapshot(),
    chat: workspace.getActiveController().getState(),
  });
  runtimeRef.current = appRuntime;
  const sessionRuntime = new AppSessionRuntime(appRuntime, workspace, {
    onAgentModeChanged: async (mode) => {
      await permissionManager.setModeCap({ agentMode: mode, reviewActive: appRuntime!.getSnapshot().run.reviewActive });
      appRuntime!.dispatch({ type: 'permission.changed', permissions: permissionManager.snapshot() });
    },
  });
  const unsubscribePermissionRuntime = permissionPromptCoordinator.subscribe(() => {
    const run = appRuntime!.getSnapshot().run;
    if (run.phase === 'idle') return;
    const awaitingPermission = permissionPromptCoordinator.getSnapshot() !== undefined;
    const controllerRun = workspace.getActiveController().getActiveRun();
    appRuntime!.dispatch({
      type: 'run.changed',
      run: {
        ...run,
        phase: awaitingPermission
          ? 'awaiting_permission'
          : controllerRun?.phase ?? (run.reviewActive ? 'streaming' : 'idle'),
      },
    });
  });
  const memoryManager = new MemoryManager({
    cwd: projectRoot,
    homeDir: runtimeHomeDir,
    autoNotesEnabled: resolvedConfig.config.autoNotesEnabled,
  });
  const statusService = new StatusService({
    getAppSnapshot: appRuntime.getSnapshot,
    cwd: runtimeCwd,
    provider: {
      protocol: resolvedConfig.config.protocol,
      model: resolvedConfig.config.model,
      thinkingEnabled: resolvedConfig.config.thinking.enabled,
    },
    getContextStatus: () => workspace.getActiveController().getContextStatus(),
    getMemoryStatus: async () => (await memoryManager.list()).status,
    probeGit: async () => {
      const git = await getGitContext(projectRoot);
      if (git === undefined) throw new Error('Git unavailable');
      return { branch: git.branch, dirty: git.dirty ?? false };
    },
    probeMcp: async () => summarizeMcp(mcp.initResults),
    config: { source: resolvedConfig.source, path: resolvedConfig.path },
  });

  let latestSessions: readonly WorkspaceSessionSummary[] = await workspace.listSessions();
  let latestMemory: MemoryIndexSnapshot = await memoryManager.list();
  latestRules = await permissionManager.getRuleViews();
  const contextBuilder = new CommandContextBuilder({
    getAppSnapshot: appRuntime.getSnapshot,
    getSessionSnapshot: () => workspace.getActiveSnapshot(),
    getQueueSnapshot: () => workspace.getActiveQueue().snapshot(),
    getPermissionSnapshot: () => permissionManager.snapshot(),
    getPermissionRules: async () => latestRules,
    getMemorySnapshot: async () => latestMemory,
    getSessionSnapshots: async () => latestSessions,
    getStatusSnapshot: async (operation) =>
      operation?.kind === 'status.open' ? statusService.getDetailedStatus() : undefined,
  });

  const reviewRunner = createReviewRunner({
    provider,
    model: resolvedConfig.config.model,
    toolRegistry: mcp.toolRegistry,
    createToolContext: (signal) => ({
      cwd: runtimeCwd,
      timeoutMs: resolvedConfig.config.request.timeoutMs,
      secrets: [resolvedConfig.config.apiKey],
      maxOutputBytes: 64 * 1024,
      ...(signal !== undefined ? { signal } : {}),
    }),
    validateTarget: (target) => validateFrozenReviewTarget(target, { cwd: projectRoot }),
    persistResult: (result) => workspace.getActiveController().persistReviewResult(result.target.diffHash, result),
  });

  const commandExecutorRef: { current?: AppCommandExecutor } = {};
  const interactions = new InteractionCoordinator({
    getState: () => ({
      sessionId: workspace.getActiveSnapshot().id,
      activeRunExists:
        appRuntime!.getSnapshot().run.phase !== 'idle' || appRuntime!.getSnapshot().queue.draining,
      agentMode: appRuntime!.getSnapshot().mode,
      reviewActive: appRuntime!.getSnapshot().run.reviewActive,
    }),
    execute: (request, response) => {
      if (commandExecutorRef.current === undefined) throw new Error('Command executor is not initialized.');
      return commandExecutorRef.current.executeInteraction(request, response);
    },
    validateTarget: (request) => validateInteractionTarget(request, workspace, permissionManager, memoryManager),
    onClosed: (request) => {
      commandExecutorRef.current?.interactionClosed(request);
      appRuntime!.dispatch({ type: 'interaction.closed', id: request.id });
    },
  });
  const commandExecutor = new AppCommandExecutor({
    runtime: appRuntime,
    sessions: sessionRuntime,
    workspace,
    interactions,
    permissions: permissionManager,
    memory: memoryManager,
    freezeReviewTarget: (input, signal) => (dependencies.freezeReviewTarget ?? freezeReviewTarget)(input, {
      cwd: projectRoot,
      ...(signal !== undefined ? { signal } : {}),
    }),
    reviewRunner,
    refreshCompletionSources: async (source) => {
      if (source === 'sessions') latestSessions = await workspace.listSessions();
      if (source === 'memory') latestMemory = await memoryManager.list();
      if (source === 'permissions') latestRules = await permissionManager.getRuleViews();
    },
  });
  commandExecutorRef.current = commandExecutor;
  const dispatcher = new CommandDispatcher({ contextBuilder, executor: commandExecutor });
  const completion = new CommandCompletionService(commandRegistry, {
    sessions: () => latestSessions,
    memory: () => latestMemory,
    permissionRules: () => latestRules,
  });
  const inputRouter = new InputRouter({
    parser: new CommandParser(commandRegistry),
    dispatcher,
    workspace: sessionRuntime,
    reviewSteer: (text) => commandExecutor.steerReview(text),
    getAppSnapshot: appRuntime.getSnapshot,
    complete: (text, direction) => completion.complete(text, direction),
    getCompletionCandidates: (text) => completion.candidates(text),
    resetCompletion: () => completion.reset(),
    toggleMode: async () => {
      const next = appRuntime!.getSnapshot().mode === 'plan' ? 'default' : 'plan';
      await sessionRuntime.setAgentMode(next);
      return { accepted: true };
    },
    onCommandResult: (result) => {
      if (result.kind === 'completed') {
        appRuntime!.dispatch({ type: 'command.error.cleared' });
      } else {
        appRuntime!.dispatch({
          type: 'command.error',
          error: { code: result.error.code, message: result.error.message, at: Date.now() },
        });
      }
    },
    onAccepted: () => appRuntime!.dispatch({ type: 'command.error.cleared' }),
    onError: (error) => {
      const code =
        typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'input_rejected';
      appRuntime!.dispatch({
        type: 'command.error',
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        },
      });
    },
  });

  let disposed = false;
  const disposeApp = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    commandExecutor.dispose();
    unsubscribePermissionRuntime();
    interactions.expire(() => true, 'expired');
    await Promise.allSettled([sessionRuntime.dispose(), mcp.dispose()]);
  };

  return renderApp(
    <App
      runtime={appRuntime}
      inputRouter={inputRouter}
      statusService={statusService}
      resolvedConfig={resolvedConfig}
      cwd={runtimeCwd}
      permissionPromptCoordinator={permissionPromptCoordinator}
      interactionCoordinator={interactions}
      onDispose={disposeApp}
    />,
  );
}

async function createToolEnvironment(
  mcpServers: Awaited<ReturnType<typeof loadConfig>>['config']['mcpServers'],
  disposePermissionPrompts: () => void,
) {
  let toolRegistry = createDefaultToolRegistry();
  let initResults: McpManagerInitResult[] = [];
  if (mcpServers === undefined || Object.keys(mcpServers).length === 0) {
    return {
      toolRegistry,
      initResults,
      dispose: async () => disposePermissionPrompts(),
    };
  }

  const initialized = await initMcpManager(mcpServers, createDefaultTransport);
  initResults = initialized.initResults;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    disposePermissionPrompts();
    await initialized.manager.closeAll();
  };
  const cleanup = (): void => {
    void dispose();
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  const providerTools = createStaticRegistry([
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createRunCommandTool(),
    createGlobFilesTool(),
    createSearchCodeTool(),
    createMcpSearchTool(initialized.manager),
  ]);
  toolRegistry = createCompositeRegistry(providerTools, new Map(initialized.manager.getTools().map((tool) => [tool.name, tool])));
  return { toolRegistry, initResults, dispose };
}

function summarizeMcp(results: readonly McpManagerInitResult[]): { configured: number; connected: number; failed: number } {
  return {
    configured: results.length,
    connected: results.filter((result) => result.status === 'connected').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
}

function toRuntimeQueue(workspace: SessionWorkspace<RuntimeSessionController>) {
  const queue = workspace.getActiveQueue().snapshot();
  return { count: queue.items.length, paused: queue.paused, draining: false, version: queue.version };
}

async function validateInteractionTarget(
  request: InteractionRequest,
  workspace: SessionWorkspace<RuntimeSessionController>,
  permissions: PermissionManager,
  memory: MemoryManager,
): Promise<boolean> {
  if (request.kind === 'confirm-memory-delete') {
    try {
      const target = await memory.prepareDelete(request.scope, request.entry);
      return memoryDeleteFingerprint(target) === request.fingerprint;
    } catch {
      return false;
    }
  }
  if (request.kind === 'confirm-permission-remove' || request.kind === 'confirm-permission-mode') {
    return permissions.snapshot().generation === request.generation;
  }
  if (request.kind === 'confirm-queue-remove' || request.kind === 'confirm-queue-clear') {
    return workspace.getActiveQueue().snapshot().version === request.queueVersion;
  }
  return true;
}
