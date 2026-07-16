import { runAgentLoop } from '../agent/AgentLoop.js';
import type {
  AgentLoopConfig,
  AgentLoopDeps,
  AgentLoopEvent,
  AgentLoopInput,
  AgentLoopMode,
  PlanStep,
} from '../agent/types.js';
import { DEFAULT_AGENT_LOOP_CONFIG } from '../agent/types.js';
import type { AgentConfig } from '../config/schema.js';
import { ContextManager } from '../context/ContextManager.js';
import { lookupContextWindow } from '../context/contextWindow.js';
import { join } from 'node:path';
import type { AutoNoteWriterPort } from '../notes/AutoNoteWriter.js';
import type { ChatModelProvider, ChatMessage as ProviderChatMessage } from '../providers/types.js';
import { type PublicError, toPublicError } from '../shared/errors.js';
import { type IdGenerator, createId } from '../shared/ids.js';
import { getGitContext } from '../system-prompt/getGitContext.js';
import { buildSystemPrompt } from '../system-prompt/index.js';
import type { EnvContext, SystemPromptBuilder, SystemPromptModule } from '../system-prompt/types.js';
import { summarizeToolResult } from '../tools/summarize.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/types.js';
import type { AskPermissionFn, PermissionChecker, PermissionMode } from '../tools/permissions/types.js';
import { createPermissionChecker } from '../tools/permissions/checker.js';
import { loadPermissionRules } from '../tools/permissions/config.js';
import { cloneProviderMessage } from './archiveSchema.js';
import type { SessionArchivePort } from './SessionArchive.js';
import type {
  ChatMessage,
  ChatSessionDraft,
  ChatSessionEvent,
  ChatSessionState,
  MessagePart,
  MessageRole,
} from './types.js';

export interface ChatSessionControllerOptions {
  provider: ChatModelProvider;
  config: AgentConfig;
  createId?: IdGenerator;
  now?: () => number;
  toolRegistry?: ToolRegistry;
  cwd?: string;
  toolTimeoutMs?: number;
  maxToolOutputBytes?: number;
  toolSecrets?: readonly string[];
  agentLoopConfig?: Partial<AgentLoopConfig>;
  /** 依赖注入：系统提示构建器，便于测试 mock */
  buildSystemPrompt?: SystemPromptBuilder;
  /** 自定义系统提示模块注册表（含动态加载内容） */
  systemPromptRegistry?: SystemPromptModule[];
  /** 权限模式覆盖（默认从 config 读取，fallback 'normal'） */
  permissionMode?: PermissionMode;
  /** 权限弹窗回调（TUI 层注入） */
  askPermission?: AskPermissionFn;
  /** 用户 home 目录（用于加载全局权限配置） */
  homeDir?: string;
  /** 依赖注入：ContextManager 实例（用于测试） */
  contextManager?: ContextManager;
  /** 恢复后的 Provider 历史上下文 */
  initialProviderContext?: readonly ProviderChatMessage[];
  /** 恢复后的 TUI 历史消息 */
  initialMessages?: readonly ChatMessage[];
  /** 会话归档端口（可注入，便于测试） */
  sessionArchive?: SessionArchivePort;
  /** 自动笔记端口（可注入，便于测试） */
  autoNoteWriter?: AutoNoteWriterPort;
}

export interface SubmitUserTextOptions {
  signal?: AbortSignal;
}

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export class ChatSessionController {
  private readonly provider: ChatModelProvider;
  private readonly config: AgentConfig;
  private readonly createIdFn: IdGenerator;
  private readonly now: () => number;
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly cwd: string;
  private readonly toolTimeoutMs: number;
  private readonly maxToolOutputBytes: number;
  private readonly toolSecrets: readonly string[];
  private readonly agentLoopConfig: AgentLoopConfig;
  private readonly messages: ChatMessage[] = [];
  private readonly contextMessages: ChatMessage[] = [];
  /** Provider 级别的上下文消息（含工具调用历史），直接作为 AgentLoop 输入 */
  private providerContext: ProviderChatMessage[] = [];
  private draft: ChatSessionDraft | undefined;
  private status: ChatSessionState['status'] = 'idle';
  private lastError: PublicError | undefined;
  private currentMode: AgentLoopMode;
  private storedPlan: PlanStep[] | undefined;
  /** 当前 turn 内累积的工具调用摘要 */
  private toolActivities: MessagePart[] = [];
  /** 瞬态系统提示，下次 state 事件后清除 */
  private notice: string | undefined;
  /** 当前 turn 索引（每轮 +1） */
  private turnIndex = 0;
  /** 运行环境上下文（每轮刷新 git 信息） */
  private envContext: EnvContext;
  /** 会话级系统提示（构造时计算一次） */
  private readonly systemPrompt: string;
  /** 系统提示构建器（可注入） */
  private readonly buildSystemPromptFn: SystemPromptBuilder;
  /** 系统提示模块注册表（可注入） */
  private readonly systemPromptRegistry: SystemPromptModule[] | undefined;
  /** 权限检查器（可选） */
  private readonly permissionChecker: PermissionChecker | undefined;
  /** full 模式下的权限策略；初始 plan 配置回退到 normal */
  private readonly fullPermissionMode: Exclude<PermissionMode, 'plan'>;
  /** F1/F2/F3：上下文管理器 */
  private readonly contextManager: ContextManager;
  private readonly sessionArchive: SessionArchivePort | undefined;
  private readonly autoNoteWriter: AutoNoteWriterPort | undefined;
  /** 当前 turn 内累计的 completion token 数 */
  private _turnCompletionTokens = 0;

  constructor(options: ChatSessionControllerOptions) {
    this.provider = options.provider;
    this.config = options.config;
    this.createIdFn = options.createId ?? createId;
    this.now = options.now ?? Date.now;
    this.toolRegistry = options.toolRegistry;
    this.cwd = options.cwd ?? process.cwd();
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.maxToolOutputBytes = options.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
    this.toolSecrets = options.toolSecrets ?? [];
    this.agentLoopConfig = {
      ...DEFAULT_AGENT_LOOP_CONFIG,
      ...options.agentLoopConfig,
    };
    this.sessionArchive = options.sessionArchive;
    this.autoNoteWriter = options.autoNoteWriter;

    const configuredPermissionMode = options.permissionMode ?? this.config.permissionMode;
    this.fullPermissionMode = configuredPermissionMode === 'plan' ? 'normal' : configuredPermissionMode;
    this.currentMode = configuredPermissionMode === 'plan' ? 'plan' : 'full';

    // 系统提示初始化
    this.buildSystemPromptFn = options.buildSystemPrompt ?? buildSystemPrompt;
    this.systemPromptRegistry = options.systemPromptRegistry;
    this.envContext = {
      os: process.platform,
      shell: process.env.SHELL ?? (process.platform === 'win32' ? 'powershell' : 'bash'),
      cwd: this.cwd,
      date: new Date().toISOString().slice(0, 10),
    };
    const { system } = this.buildSystemPromptFn(
      {
        mode: this.currentMode,
        turnIndex: 0,
        env: this.envContext,
      },
      this.systemPromptRegistry,
    );
    this.systemPrompt = system;

    // 权限系统初始化
    const homeDir = options.homeDir ?? (process.env.HOME ?? process.env.USERPROFILE ?? '');
    const ruleConfig = loadPermissionRules(this.cwd, homeDir);
    this.permissionChecker = createPermissionChecker({
      mode: this.resolvePermissionMode(this.currentMode),
      ruleConfig,
      cwd: this.cwd,
      ...(options.askPermission !== undefined ? { askFn: options.askPermission } : {}),
    });

    // 上下文管理器初始化（可注入，用于测试）
    this.contextManager = options.contextManager ?? new ContextManager(
      this.provider,
      this.config.model,
      {
        contextWindow: lookupContextWindow(this.config.model),
        offloadThresholdBytes: 8192,
        turnOffloadThresholdBytes: 32768,
        cacheDir: join(this.cwd, '.agentcode', 'context-cache'),
        timeoutMs: this.config.request.timeoutMs,
      },
    );

    const initialProviderContext = (options.initialProviderContext ?? []).map(cloneProviderMessage);
    const initialMessages = (options.initialMessages ?? []).map(cloneMessage);
    this.providerContext = initialProviderContext;
    this.messages.push(...initialMessages.map(cloneMessage));
    this.contextMessages.push(...initialMessages.map(cloneMessage));
    if (initialProviderContext.length > 0) {
      this.contextManager.onMessagesAppended(initialProviderContext);
    }
    this.turnIndex = initialMessages.filter((message) => message.role === 'user').length;
  }

  getState(): ChatSessionState {
    return this.snapshotState();
  }

  /** 切换运行模式（full ↔ plan），返回切换后的状态事件 */
  toggleMode(): ChatSessionEvent {
    const nextMode = this.currentMode === 'full' ? 'plan' : 'full';
    this.setLoopMode(nextMode);
    const label = nextMode === 'plan' ? 'plan' : 'full';
    this.notice = `Switched to ${label} mode`;
    return this.createStateChangedEvent();
  }

  async *submitUserText(text: string, options: SubmitUserTextOptions = {}): AsyncIterable<ChatSessionEvent> {
    if (this.status === 'streaming') {
      this.lastError = {
        code: 'provider_error',
        message: 'Cannot submit a new message while the previous response is still streaming.',
        retryable: false,
      };
      yield this.createStateChangedEvent();
      return;
    }

    // 清除上一次切换产生的瞬态通知
    this.notice = undefined;

    // 识别命令（/compact、/plan、/do）
    const { mode, actualText, isCompact } = this.parseCommand(text);

    // /compact 在写入 UI 历史前拦截，且始终由 ContextManager 决定压缩档位。
    if (isCompact === true) {
      const previousStatus = this.status;
      const previousLastError = this.lastError;
      this.status = 'streaming';
      try {
        yield this.createStateChangedEvent();
        try {
          await this.contextManager.offloadToolResults(this.providerContext);
          const result = await this.contextManager.compact(this.providerContext, {
            trigger: 'manual',
            originalUserMessages: this.getOriginalUserMessages(),
          });
          if (result.outcome === 'compacted') {
            this.notice = '上下文已压缩';
          } else if (result.outcome === 'emergency_fallback') {
            this.notice = '上下文已紧急压缩，摘要失败后已使用机械兜底';
          } else if (result.outcome === 'skipped' && result.reason === 'no_history') {
            this.notice = '没有可压缩的历史';
          } else {
            this.notice = '上下文压缩失败，请稍后重试';
          }
        } catch {
          this.notice = '上下文压缩失败，请稍后重试';
        }
      } finally {
        this.status = previousStatus;
        this.lastError = previousLastError;
      }
      yield this.createStateChangedEvent();
      return;
    }

    this.setLoopMode(mode);
    this._turnCompletionTokens = 0;

    const userMessage = this.createMessage('user', actualText);
    this.messages.push(userMessage);
    this.draft = {
      id: this.createIdFn('draft'),
      visibleText: '',
      thinkingText: '',
      activity: { type: 'thinking' },
    };
    this.status = 'streaming';
    this.lastError = undefined;
    this.toolActivities = [];
    yield this.createStateChangedEvent();

    // 如果没有 toolRegistry，降级为无工具模式但仍走 AgentLoop
    const registry = this.toolRegistry;

    try {
      // 每轮刷新 git 上下文 + 日期
      const gitCtx = await getGitContext(this.cwd);
      const freshDate = new Date().toISOString().slice(0, 10);
      if (gitCtx !== undefined) {
        // 先移除旧 git 字段，再重新赋值（避免 dirty 超时时残留旧值）
        const { gitBranch: _ob, gitDirty: _od, ...base } = this.envContext;
        this.envContext = {
          ...base,
          date: freshDate,
          gitBranch: gitCtx.branch,
          ...(gitCtx.dirty !== undefined ? { gitDirty: gitCtx.dirty } : {}),
        };
      } else {
        // 不在 git 仓库中，清除旧的 git 字段
        const { gitBranch: _b, gitDirty: _d, ...rest } = this.envContext;
        this.envContext = { ...rest, date: freshDate };
      }

      // 构建当前轮 reminder
      const { reminder } = this.buildSystemPromptFn(
        {
          mode: this.currentMode,
          turnIndex: this.turnIndex,
          ...(this.storedPlan !== undefined ? { plan: this.storedPlan } : {}),
          env: this.envContext,
        },
        this.systemPromptRegistry,
      );
      this.turnIndex++;

      // 在 AgentLoop 前执行工具结果卸载，再由 ContextManager 统一判断自动压缩档位。
      // 当前 userMessage 尚未进入 contextMessages（在 completeTurn/failTurn 才写入），
      // 需显式追加到 originalUserMessages，确保本轮用户请求出现在摘要第 6 节。
      await this.contextManager.offloadToolResults(this.providerContext);
      await this.contextManager.compact(this.providerContext, {
        trigger: 'auto',
        originalUserMessages: [...this.getOriginalUserMessages(), toProviderMessage(userMessage).content],
      });

      const input: AgentLoopInput = {
        contextMessages: [...this.providerContext],
        userMessage: toProviderMessage(userMessage),
        mode: this.currentMode,
        ...(reminder.length > 0 ? { reminder } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };

      const deps: AgentLoopDeps = {
        provider: this.provider,
        toolRegistry: registry ?? createEmptyRegistry(),
        createToolContext: (signal?: AbortSignal): ToolExecutionContext => ({
          cwd: this.cwd,
          timeoutMs: this.toolTimeoutMs,
          secrets: [this.config.apiKey, ...this.toolSecrets],
          maxOutputBytes: this.maxToolOutputBytes,
          ...(signal !== undefined ? { signal } : {}),
          ...(this.permissionChecker !== undefined ? { permissionChecker: this.permissionChecker } : {}),
        }),
        config: this.agentLoopConfig,
        model: this.config.model,
        thinking: this.config.thinking,
        ...(this.systemPrompt !== undefined ? { system: this.systemPrompt } : {}),
      };

      for await (const event of runAgentLoop(input, deps)) {
        const stateEvent = await this.applyAgentLoopEvent(event, userMessage);
        if (stateEvent !== undefined) {
          yield stateEvent;
        }
      }
    } catch (error) {
      this.failTurn(userMessage, toPublicError(error));
      yield this.createStateChangedEvent();
    }
  }

  private async applyAgentLoopEvent(
    event: AgentLoopEvent,
    userMessage: ChatMessage,
  ): Promise<ChatSessionEvent | undefined> {
    switch (event.type) {
      case 'text.delta': {
        const draft = this.requireDraft();
        this.draft = { ...draft, visibleText: `${draft.visibleText}${event.delta}` };
        return this.createStateChangedEvent();
      }

      case 'thinking.delta': {
        const draft = this.requireDraft();
        this.draft = { ...draft, thinkingText: `${draft.thinkingText}${event.delta}` };
        return this.createStateChangedEvent();
      }

      case 'tool_call.start': {
        const toolName = event.knownTool ? event.call.name : 'tool';
        const draft = this.requireDraft();
        this.draft = { ...draft, activity: { type: 'tool', toolName }, visibleText: '' };
        return this.createStateChangedEvent();
      }

      case 'tool_call.result': {
        // 收集工具活动摘要（安全：未知工具名用泛化名称，避免泄露恶意名称）
        const isUnknownTool = !event.result.ok && event.result.error.code === 'unknown_tool';
        const safeToolName = isUnknownTool ? 'tool' : event.call.name;
        const summary = isUnknownTool ? 'tool ✗ unknown_tool' : summarizeToolResult(event.result);
        this.toolActivities.push({
          type: 'tool_use',
          toolName: safeToolName,
          summary,
          isError: !event.result.ok,
        });
        return undefined;
      }

      case 'iteration.start': {
        // 新一轮迭代开始：重置 draft 文本
        const draft = this.requireDraft();
        this.draft = { ...draft, visibleText: '', thinkingText: '', activity: { type: 'thinking' } };
        return this.createStateChangedEvent();
      }

      case 'plan.submitted':
        this.storedPlan = event.steps;
        return undefined;

      case 'token.usage':
        this.contextManager.onTokenUsage(event.totalPromptTokens);
        this._turnCompletionTokens += event.completionTokens ?? 0;
        return undefined;

      case 'loop.retrying':
        // 重试中：更新 draft activity 提示用户
        return undefined;

      case 'loop.completed':
        await this.completeTurn(
          userMessage,
          event.finalText,
          event.turnMessages,
          event.reason === 'max_iterations' ? 'max_iterations' : undefined,
        );
        return this.createStateChangedEvent();

      case 'loop.failed': {
        // code 为 provider_error 且消息明确指示输入过长时提示使用 /compact。
        // 使用与 ContextManager.classifySummaryError 一致的精确模式，避免误匹配
        // "authentication token expired"、"invalid key length" 等无关错误。
        if (event.error.code === 'provider_error' && isInputTooLongMessage(event.error.message)) {
          this.notice = '上下文过长，请使用 /compact 压缩后继续';
        }
        this.failTurn(userMessage, event.error);
        return this.createStateChangedEvent();
      }

      default: {
        // exhaustive check: 新增事件类型时编译器会报错
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private parseCommand(text: string): { mode: AgentLoopMode; actualText: string; isCompact?: boolean } {
    const trimmed = text.trim();
    if (/^\/compact\b/i.test(trimmed)) {
      return { mode: this.currentMode, actualText: '', isCompact: true };
    }
    if (/^\/plan\b/i.test(trimmed)) {
      return { mode: 'plan', actualText: trimmed.slice(5).trim() || trimmed };
    }
    if (/^\/do\b/i.test(trimmed)) {
      return { mode: 'full', actualText: trimmed.slice(3).trim() || trimmed };
    }
    return { mode: this.currentMode, actualText: text };
  }

  private setLoopMode(mode: AgentLoopMode): void {
    this.currentMode = mode;
    this.permissionChecker?.setMode(this.resolvePermissionMode(mode));
  }

  private resolvePermissionMode(mode: AgentLoopMode): PermissionMode {
    return mode === 'plan' ? 'plan' : this.fullPermissionMode;
  }

  private async completeTurn(
    userMessage: ChatMessage,
    finalText: string,
    turnMessages: ProviderChatMessage[],
    finishReason: string | undefined,
  ): Promise<void> {
    const completionTokens = this._turnCompletionTokens;
    this._turnCompletionTokens = 0;
    // 构建 assistant message，包含 tool_use parts + text part
    const parts: MessagePart[] = [...this.toolActivities, { type: 'text', text: finalText }];
    const assistantMessage: ChatMessage = {
      id: this.createIdFn('assistant'),
      role: 'assistant',
      parts,
      createdAt: this.now(),
      meta: {
        model: this.config.model,
        provider: this.provider.protocol,
        ...(finishReason !== undefined ? { finishReason } : {}),
      },
    };
    this.messages.push(assistantMessage);
    this.contextMessages.push(userMessage, assistantMessage);

    const appendedMessages: ProviderChatMessage[] = [
      toProviderMessage(userMessage),
      ...turnMessages,
      { role: 'assistant', content: finalText },
    ];
    this.providerContext.push(...appendedMessages);
    this.contextManager.onMessagesAppended(appendedMessages);

    if (this.sessionArchive !== undefined) {
      try {
        await this.sessionArchive.append(appendedMessages);
      } catch (error) {
        console.warn('[SessionArchive] 会话存档失败', error);
      }
    }
    if (this.autoNoteWriter !== undefined) {
      try {
        void this.autoNoteWriter
          .maybeUpdate({
            userText: toProviderMessage(userMessage).content,
            assistantText: finalText,
            completionTokens,
          })
          .catch((error) => {
            console.warn('[AutoNoteWriter] 自动笔记更新失败', error);
          });
      } catch (error) {
        console.warn('[AutoNoteWriter] 自动笔记更新启动失败', error);
      }
    }

    this.toolActivities = [];
    this.draft = undefined;
    this.status = 'idle';
    this.lastError = undefined;
  }

  private failTurn(userMessage: ChatMessage, error: PublicError): void {
    this._turnCompletionTokens = 0;
    if (!this.contextMessages.some((message) => message.id === userMessage.id)) {
      this.contextMessages.push(userMessage);
      const appendedMessages: ProviderChatMessage[] = [toProviderMessage(userMessage)];
      this.providerContext.push(...appendedMessages);
      this.contextManager.onMessagesAppended(appendedMessages);
    }

    this.draft = undefined;
    this.status = 'error';
    this.lastError = error;
  }

  private getOriginalUserMessages(): string[] {
    return this.contextMessages
      .filter((message) => message.role === 'user')
      .map((message) => toProviderMessage(message).content);
  }

  private createMessage(role: MessageRole, text: string, finishReason?: string): ChatMessage {
    const message: ChatMessage = {
      id: this.createIdFn(role),
      role,
      parts: [{ type: 'text', text }],
      createdAt: this.now(),
    };

    if (role === 'assistant') {
      message.meta = {
        model: this.config.model,
        provider: this.provider.protocol,
        ...(finishReason !== undefined ? { finishReason } : {}),
      };
    }

    return message;
  }

  private requireDraft(): ChatSessionDraft {
    if (this.draft === undefined) {
      throw new Error('Chat session draft is not available.');
    }
    return this.draft;
  }

  private createStateChangedEvent(): ChatSessionEvent {
    return { type: 'state.changed', state: this.snapshotState() };
  }

  private snapshotState(): ChatSessionState {
    const state: ChatSessionState = {
      messages: this.messages.map(cloneMessage),
      status: this.status,
      mode: this.currentMode,
    };

    if (this.draft !== undefined) {
      state.draft = { ...this.draft };
    }

    if (this.lastError !== undefined) {
      state.lastError = { ...this.lastError };
    }

    if (this.notice !== undefined) {
      state.notice = this.notice;
    }

    return state;
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────

/**
 * 判断 provider_error 消息是否明确指示输入过长。
 * 与 ContextManager.classifySummaryError 使用相同的精确模式集，
 * 避免误匹配 "authentication token expired"、"invalid key length" 等无关错误。
 */
function isInputTooLongMessage(message: string): boolean {
  const normalized = message.replace(/[_-]+/g, ' ');
  return (
    /\bcontext\s+(?:window|length)\b/i.test(normalized) ||
    /\bprompt\s+(?:is\s+)?too\s+long\b/i.test(normalized) ||
    /\binput\s+(?:is\s+)?too\s+long\b/i.test(normalized) ||
    /\bmax(?:imum)?\b[^\r\n]{0,80}\btokens?\b/i.test(normalized) ||
    /\btokens?\s+limit\b/i.test(normalized)
  );
}

function toProviderMessage(message: ChatMessage): ProviderChatMessage {
  return {
    role: message.role,
    content: message.parts
      .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join(''),
  };
}

function cloneMessage(message: ChatMessage): ChatMessage {
  const cloned: ChatMessage = {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
  };

  if (message.meta !== undefined) {
    cloned.meta = { ...message.meta };
  }

  return cloned;
}

function createEmptyRegistry(): ToolRegistry {
  return {
    list: () => [],
    get: () => undefined,
    getProviderDeclarations: () => [],
    filterByRisk: () => createEmptyRegistry(),
  };
}
