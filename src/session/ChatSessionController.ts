import type { AgentConfig } from '../config/schema.js';
import type { ChatModelProvider, ChatMessage as ProviderChatMessage } from '../providers/types.js';
import { createId, type IdGenerator } from '../shared/ids.js';
import { toPublicError, type PublicError } from '../shared/errors.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/types.js';
import { runAgentLoop } from '../agent/AgentLoop.js';
import type { AgentLoopConfig, AgentLoopDeps, AgentLoopEvent, AgentLoopInput, AgentLoopMode, PlanStep } from '../agent/types.js';
import { DEFAULT_AGENT_LOOP_CONFIG } from '../agent/types.js';
import type { ChatMessage, ChatSessionDraft, ChatSessionEvent, ChatSessionState, MessageRole } from './types.js';

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
  private draft: ChatSessionDraft | undefined;
  private status: ChatSessionState['status'] = 'idle';
  private lastError: PublicError | undefined;
  private currentMode: AgentLoopMode = 'full';
  private storedPlan: PlanStep[] | undefined;

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
  }

  getState(): ChatSessionState {
    return this.snapshotState();
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
    yield this.createStateChangedEvent();

    // 如果没有 toolRegistry，降级为无工具模式但仍走 AgentLoop
    const registry = this.toolRegistry;

    try {
      const input: AgentLoopInput = {
        contextMessages: this.contextMessages.map(toProviderMessage),
        userMessage: toProviderMessage(userMessage),
        mode: this.currentMode,
        ...(this.currentMode === 'full' && this.storedPlan ? { plan: this.storedPlan } : {}),
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

      case 'tool_call.result':
        return undefined; // 工具结果不直接触发 UI 更新

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
        this.completeTurn(userMessage, event.finalText, event.reason === 'max_iterations' ? 'max_iterations' : undefined);
        return this.createStateChangedEvent();

      case 'loop.failed':
        this.failTurn(userMessage, event.error);
        return this.createStateChangedEvent();
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
    return { mode: this.currentMode === 'plan' ? 'full' : 'full', actualText: text };
  }

  private completeTurn(userMessage: ChatMessage, finalText: string, finishReason: string | undefined): void {
    const assistantMessage = this.createMessage('assistant', finalText, finishReason);
    this.messages.push(assistantMessage);
    this.contextMessages.push(userMessage, assistantMessage);
    this.draft = undefined;
    this.status = 'idle';
    this.lastError = undefined;
  }

  private failTurn(userMessage: ChatMessage, error: PublicError): void {
    if (!this.contextMessages.some((message) => message.id === userMessage.id)) {
      this.contextMessages.push(userMessage);
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
      status: this.status
    };

    if (this.draft !== undefined) {
      state.draft = { ...this.draft };
    }

    if (this.lastError !== undefined) {
      state.lastError = { ...this.lastError };
    }

    return state;
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────

function toProviderMessage(message: ChatMessage): ProviderChatMessage {
  return {
    role: message.role,
    content: message.parts.map((part) => part.text).join('')
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
