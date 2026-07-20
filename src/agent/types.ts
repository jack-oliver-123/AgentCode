import type { ChatModelProvider, ChatMessage as ProviderMessage } from '../providers/types.js';
import type { PublicError } from '../shared/errors.js';
import type { ProviderToolCall, ToolExecutionContext, ToolExecutionResult, ToolRegistry } from '../tools/types.js';

// ─── 配置 ─────────────────────────────────────────────────────────────

/** Agent Loop 重试配置 */
export interface RetryConfig {
  /** 最大重试次数，默认 3 */
  maxRetries: number;
  /** 基础延迟 ms（指数退避），默认 1000 */
  baseDelayMs: number;
  /** 最大延迟 ms，默认 10000 */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/** Agent Loop 配置 */
export interface AgentLoopConfig {
  /** 最大迭代次数，默认 50 */
  maxIterations: number;
  /** 连续调用不存在工具的容忍次数，默认 3 */
  maxConsecutiveUnknownTools: number;
  /** 可重试错误的重试配置 */
  retry: RetryConfig;
}

export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  maxIterations: 50,
  maxConsecutiveUnknownTools: 3,
  retry: DEFAULT_RETRY_CONFIG,
};

// ─── 输入 ─────────────────────────────────────────────────────────────

/** Agent Loop 运行模式 */
export type AgentLoopMode = 'default' | 'plan';

export interface SteerGuidance {
  id: string;
  text: string;
  createdAt: number;
}

/** Agent Loop 输入 */
export interface AgentLoopInput {
  /** 历史上下文消息（前序 turn） */
  contextMessages: ProviderMessage[];
  /** 当前用户消息 */
  userMessage: ProviderMessage;
  /** 运行模式：default 注入全部工具，plan 只注入 read 类 + submit_plan */
  mode: AgentLoopMode;
  /** 当前轮 reminder 文本（注入到 userMessage 前部） */
  reminder?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 在每个安全模型边界提取运行中追加的 Steer 指导。 */
  consumeSteer?: () => readonly SteerGuidance[];
  /** Stop accepting guidance immediately after the final consume boundary. */
  closeSteerInput?: () => void;
}

/** Agent Loop 依赖（注入） */
export interface AgentLoopDeps {
  provider: ChatModelProvider;
  toolRegistry: ToolRegistry;
  /** 工厂函数，每次工具执行时创建新的 context（确保 signal 正确传播） */
  createToolContext: (signal?: AbortSignal) => ToolExecutionContext;
  config: AgentLoopConfig;
  /** 模型名称，传递给 provider request */
  model: string;
  /** thinking 配置 */
  thinking: { enabled: boolean; budgetTokens?: number };
  /** 系统提示文本（会话级稳定） */
  system?: string;
}

// ─── Plan ─────────────────────────────────────────────────────────────

/** 结构化计划步骤 */
export interface PlanStep {
  title: string;
  description: string;
}

// ─── 事件流 ───────────────────────────────────────────────────────────

/** Agent Loop 对外事件流（discriminated union） */
export type AgentLoopEvent =
  | AgentLoopIterationStart
  | AgentLoopTextDelta
  | AgentLoopThinkingDelta
  | AgentLoopToolCallStart
  | AgentLoopToolCallResult
  | AgentLoopPlanSubmitted
  | AgentLoopTokenUsage
  | AgentLoopRetrying
  | AgentLoopSteerConsumed
  | AgentLoopCompleted
  | AgentLoopFailed;

export interface AgentLoopIterationStart {
  type: 'iteration.start';
  /** 当前第几轮（从 1 开始） */
  iteration: number;
  /** 配置的最大迭代数 */
  maxIterations: number;
}

export interface AgentLoopTextDelta {
  type: 'text.delta';
  /** 本次增量文本 */
  delta: string;
}

export interface AgentLoopThinkingDelta {
  type: 'thinking.delta';
  /** 本次增量 thinking 文本 */
  delta: string;
}

export interface AgentLoopToolCallStart {
  type: 'tool_call.start';
  /** 工具调用信息 */
  call: ProviderToolCall;
  /** 该工具是否在当前 registry 中注册 */
  knownTool: boolean;
  /** 所属迭代轮次 */
  iteration: number;
}

export interface AgentLoopToolCallResult {
  type: 'tool_call.result';
  /** 工具调用信息 */
  call: ProviderToolCall;
  /** 执行结果 */
  result: ToolExecutionResult;
  /** 执行耗时 ms */
  durationMs: number;
  /** 所属迭代轮次 */
  iteration: number;
}

export interface AgentLoopPlanSubmitted {
  type: 'plan.submitted';
  /** 结构化计划步骤列表 */
  steps: PlanStep[];
}

export interface AgentLoopTokenUsage {
  type: 'token.usage';
  /** 本轮 prompt tokens（增量） */
  promptTokens?: number;
  /** 本轮 completion tokens（增量） */
  completionTokens?: number;
  /** 累计 prompt tokens */
  totalPromptTokens: number;
  /** 累计 completion tokens */
  totalCompletionTokens: number;
}

export interface AgentLoopRetrying {
  type: 'loop.retrying';
  /** 第几次重试（从 1 开始） */
  attempt: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 本次等待延迟 ms */
  delayMs: number;
  /** 触发重试的错误 */
  error: PublicError;
  /** 所属迭代轮次 */
  iteration: number;
}

export interface AgentLoopSteerConsumed {
  type: 'steer.consumed';
  items: readonly SteerGuidance[];
}

export interface AgentLoopCompleted {
  type: 'loop.completed';
  /** 最终文本回答（最后一轮累积） */
  finalText: string;
  /** 总迭代次数 */
  totalIterations: number;
  /** 终止原因 */
  reason: AgentLoopStopReason;
  /** 本次 turn 内产生的全部消息（含工具调用/结果），用于跨 turn 上下文累积 */
  turnMessages: ProviderMessage[];
}

export interface AgentLoopFailed {
  type: 'loop.failed';
  /** 错误信息 */
  error: PublicError;
  /** 出错时的迭代轮次 */
  iteration: number;
}

// ─── 停止条件 ─────────────────────────────────────────────────────────

export type AgentLoopStopReason =
  | 'natural' // 模型返回纯文本，不再请求工具
  | 'max_iterations' // 达到迭代上限
  | 'cancelled' // 用户取消
  | 'unknown_tool_limit'; // 连续幻觉工具

/** 停止条件判断的输入（纯函数） */
export interface StopConditionContext {
  iteration: number;
  maxIterations: number;
  consecutiveUnknownTools: number;
  maxConsecutiveUnknownTools: number;
  signal?: AbortSignal;
  /** 本轮是否有工具调用 */
  hasToolCalls: boolean;
  /** 本轮是否有 provider 错误 */
  hasError: boolean;
}

export type StopDecision = { stop: false } | { stop: true; reason: AgentLoopStopReason | 'provider_error' };

// ─── 工具调度 ─────────────────────────────────────────────────────────

/** 工具调度批次 */
export interface ToolBatch {
  calls: ProviderToolCall[];
  mode: 'concurrent' | 'sequential';
}

// ─── 重导出便捷类型 ───────────────────────────────────────────────────

export type { ProviderMessage, ProviderToolCall, ToolExecutionResult, ToolRegistry };
export type { ChatModelProvider } from '../providers/types.js';
export type { PublicError } from '../shared/errors.js';
