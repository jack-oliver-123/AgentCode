import type { AgentConfig } from '../config/schema.js';
import type { ChatModelProvider, ChatMessage as ProviderChatMessage } from '../providers/types.js';
import { createId, type IdGenerator } from '../shared/ids.js';
import { toPublicError, type PublicError } from '../shared/errors.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/types.js';
import { summarizeToolResult } from '../tools/summarize.js';
import { runAgentLoop } from '../agent/AgentLoop.js';
import type { AgentLoopConfig, AgentLoopDeps, AgentLoopEvent, AgentLoopInput, AgentLoopMode, PlanStep } from '../agent/types.js';
import { DEFAULT_AGENT_LOOP_CONFIG } from '../agent/types.js';
import type { ChatMessage, ChatSessionDraft, ChatSessionEvent, ChatSessionState, MessagePart, MessageRole } from './types.js';
import { buildSystemPrompt } from '../system-prompt/index.js';
import type { SystemPromptBuilder, SystemPromptModule, EnvContext } from '../system-prompt/types.js';
import { getGitContext } from '../system-prompt/getGitContext.js';

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
  private currentMode: AgentLoopMode = 'full';
  private storedPlan: PlanStep[] | undefined;
  /** 当前 turn 内累积的工具调用摘要 */
  private toolActivities: MessagePart[] = [];
  /** 瞬态系统提示，下次 state 事件后清除 */
  private notice: string | undefined;
  /** 当前 turn 索引（每轮 +1） */
  private turnIndex: number = 0;
  /** 运行环境上下文（每轮刷新 git 信息） */
  private envContext: EnvContext;
  /** 会话级系统提示（构造时计算一次） */
  private readonly systemPrompt: string;
  /** 系统提示构建器（可注入） */
  private readonly buildSystemPromptFn: SystemPromptBuilder;
  /** 系统提示模块注册表（可注入） */
  private readonly systemPromptRegistry: SystemPromptModule[] | undefined;

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

    // 系统提示初始化
    this.buildSystemPromptFn = options.buildSystemPrompt ?? buildSystemPrompt;
    this.systemPromptRegistry = options.systemPromptRegistry;
    this.envContext = {
      os: process.platform,
      shell: process.env.SHELL ?? (process.platform === 'win32' ? 'powershell' : 'bash'),
      cwd: this.cwd,
      date: new Date().toISOString().slice(0, 10),
    };
    const { system } = this.buildSystemPromptFn({
      mode: this.currentMode,
      turnIndex: 0,
      env: this.envContext,
    }, this.systemPromptRegistry);
    this.systemPrompt = system;
  }

  getState(): ChatSessionState {
    return this.snapshotState();
  }

  /** 切换运行模式（full ↔ plan），返回切换后的状态事件 */
  toggleMode(): ChatSessionEvent {
    this.currentMode = this.currentMode === 'full' ? 'plan' : 'full';
    const label = this.currentMode === 'plan' ? 'plan' : 'full';
    this.notice = `Switched to ${label} mode`;
    return this.createStateChangedEvent();
  }

  async *submitUserText(text: string, options: SubmitUserTextOptions = {}): AsyncIterable<ChatSessionEvent> {
    if (this.status === 'streaming') {
      this.lastError = {
        code: 'provider_error',
        message: 'Cannot submit a new message while the previous response is still streaming.',
        retryable: false
      };
      yield this.createStateChangedEvent();
      return;
    }

    // 清除上一次切换产生的瞬态通知
    this.notice = undefined;

    // 识别 /plan 和 /do 命令
    const { mode, actualText } = this.parseCommand(text);
    this.currentMode = mode;

    const userMessage = this.createMessage('user', actualText);
    this.messages.push(userMessage);
    this.draft = {
      id: this.createIdFn('draft'),
      visibleText: '',
      thinkingText: '',
      activity: { type: 'thinking' }
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
        this.envContext = { ...base, date: freshDate, gitBranch: gitCtx.branch, ...(gitCtx.dirty !== undefined ? { gitDirty: gitCtx.dirty } : {}) };
      } else {
        // 不在 git 仓库中，清除旧的 git 字段
        const { gitBranch: _b, gitDirty: _d, ...rest } = this.envContext;
        this.envContext = { ...rest, date: freshDate };
      }

      // 构建当前轮 reminder
      const { reminder } = this.buildSystemPromptFn({
        mode: this.currentMode,
        turnIndex: this.turnIndex,
        ...(this.storedPlan !== undefined ? { plan: this.storedPlan } : {}),
        env: this.envContext,
      }, this.systemPromptRegistry);
      this.turnIndex++;

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
        }),
        config: this.agentLoopConfig,
        model: this.config.model,
        thinking: this.config.thinking,
        ...(this.systemPrompt !== undefined ? { system: this.systemPrompt } : {}),
      };

      for await (const event of runAgentLoop(input, deps)) {
        const stateEvent = this.applyAgentLoopEvent(event, userMessage);
        if (stateEvent !== undefined) {
          yield stateEvent;
        }
      }
    } catch (error) {
      this.failTurn(userMessage, toPublicError(error));
      yield this.createStateChangedEvent();
    }
  }

  private applyAgentLoopEvent(event: AgentLoopEvent, userMessage: ChatMessage): ChatSessionEvent | undefined {
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
        return undefined;

      case 'loop.completed':
        this.completeTurn(userMessage, event.finalText, event.turnMessages, event.reason === 'max_iterations' ? 'max_iterations' : undefined);
        return this.createStateChangedEvent();

      case 'loop.failed':
        this.failTurn(userMessage, event.error);
        return this.createStateChangedEvent();

      default: {
        // exhaustive check: 新增事件类型时编译器会报错
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private parseCommand(text: string): { mode: AgentLoopMode; actualText: string } {
    const trimmed = text.trim();
    if (/^\/plan\b/i.test(trimmed)) {
      return { mode: 'plan', actualText: trimmed.slice(5).trim() || trimmed };
    }
    if (/^\/do\b/i.test(trimmed)) {
      return { mode: 'full', actualText: trimmed.slice(3).trim() || trimmed };
    }
    return { mode: this.currentMode, actualText: text };
  }

  private completeTurn(
    userMessage: ChatMessage,
    finalText: string,
    turnMessages: ProviderChatMessage[],
    finishReason: string | undefined
  ): void {
    // 构建 assistant message，包含 tool_use parts + text part
    const parts: MessagePart[] = [
      ...this.toolActivities,
      { type: 'text', text: finalText },
    ];
    const assistantMessage: ChatMessage = {
      id: this.createIdFn('assistant'),
      role: 'assistant',
      parts,
      createdAt: this.now(),
      meta: {
        model: this.config.model,
        provider: this.provider.protocol,
        ...(finishReason !== undefined ? { finishReason } : {})
      },
    };
    this.messages.push(assistantMessage);
    this.contextMessages.push(userMessage, assistantMessage);
    // 跨 turn 上下文：保留用户消息 + 完整工具调用历史 + 最终回答
    this.providerContext.push(
      toProviderMessage(userMessage),
      ...turnMessages,
      { role: 'assistant', content: finalText }
    );
    this.toolActivities = [];
    this.draft = undefined;
    this.status = 'idle';
    this.lastError = undefined;
  }

  private failTurn(userMessage: ChatMessage, error: PublicError): void {
    if (!this.contextMessages.some((message) => message.id === userMessage.id)) {
      this.contextMessages.push(userMessage);
      this.providerContext.push(toProviderMessage(userMessage));
    }

    this.draft = undefined;
    this.status = 'error';
    this.lastError = error;
  }

  private createMessage(role: MessageRole, text: string, finishReason?: string): ChatMessage {
    const message: ChatMessage = {
      id: this.createIdFn(role),
      role,
      parts: [{ type: 'text', text }],
      createdAt: this.now()
    };

    if (role === 'assistant') {
      message.meta = {
        model: this.config.model,
        provider: this.provider.protocol,
        ...(finishReason !== undefined ? { finishReason } : {})
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

function toProviderMessage(message: ChatMessage): ProviderChatMessage {
  return {
    role: message.role,
    content: message.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
  };
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
    ...(message.meta !== undefined ? { meta: { ...message.meta } } : {})
  };
}

function createEmptyRegistry(): ToolRegistry {
  return {
    list: () => [],
    get: () => undefined,
    getProviderDeclarations: () => [],
    filterByRisk: () => createEmptyRegistry(),
  };
}
