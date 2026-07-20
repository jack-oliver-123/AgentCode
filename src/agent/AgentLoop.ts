import type {
  AgentLoopDeps,
  AgentLoopEvent,
  AgentLoopInput,
  PlanStep,
  ProviderMessage,
  ProviderToolCall,
  RetryConfig,
  ToolExecutionResult,
} from './types.js';
import type { ProviderEvent, ProviderRequest } from '../providers/types.js';
import type { ToolRegistry } from '../tools/types.js';
import type { PublicError } from '../shared/errors.js';
import { checkStopCondition } from './stopCondition.js';
import { createBatches, executeBatches } from './ToolScheduler.js';
import { toPublicError } from '../shared/errors.js';
import { enhanceToolDeclarations } from '../system-prompt/enhanceToolDeclarations.js';

const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';

/**
 * Agent Loop 主循环 — 纯函数式 async generator
 *
 * ReAct 模式：调用 LLM → 执行工具 → 观察结果 → 继续推理，直到停止条件满足
 */
export async function* runAgentLoop(
  input: AgentLoopInput,
  deps: AgentLoopDeps,
): AsyncGenerator<AgentLoopEvent, void, undefined> {
  const { provider, toolRegistry, createToolContext, config, model, thinking } = deps;
  const { signal } = input;

  // 根据 mode 过滤工具集
  const activeRegistry = resolveRegistry(toolRegistry, input.mode);

  // reminder 注入：创建临时副本，不 mutate 原始 input.userMessage
  const effectiveUserMessage =
    input.reminder && input.reminder.length > 0
      ? {
          ...input.userMessage,
          content: `<system-reminder>\n${input.reminder}\n</system-reminder>\n\n${input.userMessage.content}`,
        }
      : input.userMessage;

  // 构建初始消息数组
  const messages: ProviderMessage[] = [...input.contextMessages, effectiveUserMessage];

  // 记录初始消息数量，后续新增的就是 turnMessages
  const initialMessageCount = messages.length;

  // 工具声明在循环内不变，提前计算
  const declarations = enhanceToolDeclarations(activeRegistry.getProviderDeclarations());

  let iteration = 0;
  let consecutiveUnknownTools = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const { retry } = config;

  while (iteration < config.maxIterations) {
    iteration++;

    yield { type: 'iteration.start', iteration, maxIterations: config.maxIterations };

    const steerBeforeRequest = input.consumeSteer?.() ?? [];
    if (steerBeforeRequest.length > 0) {
      messages.push(formatSteerGuidance(steerBeforeRequest));
      yield { type: 'steer.consumed', items: steerBeforeRequest };
    }

    // 检查 signal — 可能在迭代之间被取消
    if (signal?.aborted) {
      input.closeSteerInput?.();
      yield {
        type: 'loop.completed',
        finalText: '',
        totalIterations: iteration,
        reason: 'cancelled',
        turnMessages: messages.slice(initialMessageCount),
      };
      return;
    }

    // 构建 provider request
    const request: ProviderRequest = {
      model,
      messages: [...messages],
      thinking,
      tools: declarations,
      toolChoice: 'auto',
      ...(deps.system !== undefined ? { system: deps.system } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };

    // 带重试的 provider 调用
    const streamResult: ProviderStreamResult | undefined = yield* streamWithRetry(
      provider,
      request,
      retry,
      iteration,
      signal,
      input.closeSteerInput,
    );

    // streamWithRetry 返回 undefined 表示已 yield loop.failed 并需要终止
    if (streamResult === undefined) {
      return;
    }

    const { turnText, turnToolCalls, promptTokensDelta, completionTokensDelta } = streamResult;
    const steerAfterResponse = input.consumeSteer?.() ?? [];

    // 累积 token 计数并 yield
    if (promptTokensDelta > 0) totalPromptTokens += promptTokensDelta;
    if (completionTokensDelta > 0) totalCompletionTokens += completionTokensDelta;
    if (promptTokensDelta > 0 || completionTokensDelta > 0) {
      yield {
        type: 'token.usage',
        ...(promptTokensDelta > 0 ? { promptTokens: promptTokensDelta } : {}),
        ...(completionTokensDelta > 0 ? { completionTokens: completionTokensDelta } : {}),
        totalPromptTokens,
        totalCompletionTokens,
      };
    }

    // 停止条件判断
    const hasToolCalls = turnToolCalls.length > 0;
    if (!hasToolCalls && steerAfterResponse.length > 0) {
      messages.push({ role: 'assistant', content: turnText });
      messages.push(formatSteerGuidance(steerAfterResponse));
      yield { type: 'steer.consumed', items: steerAfterResponse };
      continue;
    }
    const decision = checkStopCondition({
      iteration,
      maxIterations: config.maxIterations,
      consecutiveUnknownTools,
      maxConsecutiveUnknownTools: config.maxConsecutiveUnknownTools,
      ...(signal !== undefined ? { signal } : {}),
      hasToolCalls,
      hasError: false,
    });

    // 任何停止条件满足时直接退出（natural, cancelled, max_iterations, unknown_tool_limit）
    if (decision.stop) {
      const reason = decision.reason === 'provider_error' ? 'unknown_tool_limit' : decision.reason;
      input.closeSteerInput?.();
      yield {
        type: 'loop.completed',
        finalText: turnText,
        totalIterations: iteration,
        reason,
        turnMessages: messages.slice(initialMessageCount),
      };
      return;
    }

    // 有工具调用 → 执行
    if (hasToolCalls) {
      // 分批
      const { batches, unknownResults } = createBatches(turnToolCalls, activeRegistry);

      // 更新连续未知工具计数
      const hasKnownTool = turnToolCalls.some((c) => activeRegistry.get(c.name) !== undefined);
      if (hasKnownTool) {
        consecutiveUnknownTools = 0;
      } else {
        consecutiveUnknownTools++;
      }

      // 更新计数后再检查 unknown_tool_limit（在执行前）
      const postCountDecision = checkStopCondition({
        iteration,
        maxIterations: config.maxIterations,
        consecutiveUnknownTools,
        maxConsecutiveUnknownTools: config.maxConsecutiveUnknownTools,
        ...(signal !== undefined ? { signal } : {}),
        hasToolCalls: true,
        hasError: false,
      });

      if (postCountDecision.stop) {
        const reason = postCountDecision.reason === 'provider_error' ? 'unknown_tool_limit' : postCountDecision.reason;
        input.closeSteerInput?.();
        yield {
          type: 'loop.completed',
          finalText: turnText,
          totalIterations: iteration,
          reason,
          turnMessages: messages.slice(initialMessageCount),
        };
        return;
      }

      // yield tool_call.start 事件
      for (const call of turnToolCalls) {
        const knownTool = activeRegistry.get(call.name) !== undefined;
        yield { type: 'tool_call.start', call, knownTool, iteration };
      }

      // 执行 batches
      const context = createToolContext(signal);
      const batchResults = await executeBatches(batches, activeRegistry, context);

      // 合并 unknown results 和 batch results，按原始调用顺序排列
      const resultMap = new Map<string, { call: ProviderToolCall; result: ToolExecutionResult; durationMs: number }>();
      for (const r of unknownResults) {
        resultMap.set(r.call.id, { ...r, durationMs: 0 });
      }
      for (const r of batchResults) {
        resultMap.set(r.call.id, r);
      }
      const allResults = turnToolCalls.map((tc) => resultMap.get(tc.id)!).filter(Boolean);

      // yield tool_call.result 事件
      for (const { call, result, durationMs } of allResults) {
        yield { type: 'tool_call.result', call, result, durationMs, iteration };
      }

      // 在任何提前结束分支前固化完整工具链，确保跨 turn 上下文与会话归档不丢消息。
      const assistantMessage: ProviderMessage = {
        role: 'assistant',
        content: turnText,
        toolCalls: turnToolCalls,
      };
      messages.push(assistantMessage);

      for (const { call, result } of allResults) {
        const toolResultMessage: ProviderMessage = {
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: serializeToolResult(result),
          isError: !result.ok,
        };
        messages.push(toolResultMessage);
      }

      if (steerAfterResponse.length > 0) {
        messages.push(formatSteerGuidance(steerAfterResponse));
        yield { type: 'steer.consumed', items: steerAfterResponse };
      }

      // 检查 submit_plan
      const planResult = allResults.find((r) => r.call.name === SUBMIT_PLAN_TOOL_NAME && r.result.ok);
      if (planResult?.result.ok) {
        const steps = (planResult.result.data as { steps: PlanStep[] }).steps;
        input.closeSteerInput?.();
        yield { type: 'plan.submitted', steps };
        yield {
          type: 'loop.completed',
          finalText: turnText,
          totalIterations: iteration,
          reason: 'natural',
          turnMessages: messages.slice(initialMessageCount),
        };
        return;
      }

      // 继续下一轮
      continue;
    }

    // 兜底：无工具调用已在上面 decision 处理，此处不应到达
    input.closeSteerInput?.();
    yield {
      type: 'loop.completed',
      finalText: turnText,
      totalIterations: iteration,
      reason: 'natural',
      turnMessages: messages.slice(initialMessageCount),
    };
    return;
  }

  // 达到迭代上限
  input.closeSteerInput?.();
  yield {
    type: 'loop.completed',
    finalText: '',
    totalIterations: iteration,
    reason: 'max_iterations',
    turnMessages: messages.slice(initialMessageCount),
  };
}

// ─── 重试相关 ─────────────────────────────────────────────────────────

/** provider 流成功消费后的结果 */
interface ProviderStreamResult {
  turnText: string;
  turnToolCalls: ProviderToolCall[];
  promptTokensDelta: number;
  completionTokensDelta: number;
}

/**
 * 带指数退避重试的 provider stream 消费。
 * 成功时返回 ProviderStreamResult；不可恢复时 yield loop.failed 并返回 undefined。
 */
async function* streamWithRetry(
  provider: { stream(req: ProviderRequest): AsyncIterable<ProviderEvent> },
  request: ProviderRequest,
  retry: RetryConfig,
  iteration: number,
  signal: AbortSignal | undefined,
  closeSteerInput: (() => void) | undefined,
): AsyncGenerator<AgentLoopEvent, ProviderStreamResult | undefined, undefined> {
  let lastError: PublicError | undefined;

  for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
    // 重试前等待（首次 attempt=0 不等待）
    if (attempt > 0) {
      const delayMs = computeRetryDelay(attempt, retry);
      yield {
        type: 'loop.retrying',
        attempt,
        maxRetries: retry.maxRetries,
        delayMs,
        error: lastError!,
        iteration,
      };
      await sleep(delayMs, signal);
      // sleep 被 abort 打断时直接退出
      if (signal?.aborted) {
        closeSteerInput?.();
        yield { type: 'loop.failed', error: lastError!, iteration };
        return undefined;
      }
    }

    let turnText = '';
    const turnToolCalls: ProviderToolCall[] = [];
    let promptTokensDelta = 0;
    let completionTokensDelta = 0;
    let receivedComplete = false;
    let streamError: PublicError | undefined;

    try {
      for await (const event of provider.stream(request)) {
        switch (event.type) {
          case 'content.delta':
            turnText += event.delta;
            yield { type: 'text.delta', delta: event.delta };
            break;

          case 'thinking.delta':
            yield { type: 'thinking.delta', delta: event.delta };
            break;

          case 'tool.call':
            turnToolCalls.push(event.call);
            break;

          case 'response.complete':
            receivedComplete = true;
            break;

          case 'response.usage': {
            const pt = typeof event.usage.inputTokens === 'number' ? event.usage.inputTokens : 0;
            const ct = typeof event.usage.outputTokens === 'number' ? event.usage.outputTokens : 0;
            promptTokensDelta += pt;
            completionTokensDelta += ct;
            break;
          }

          case 'response.error':
            streamError = event.error;
            break;

          default:
            break;
        }
      }
    } catch (error) {
      streamError = toPublicError(error);
    }

    if (signal?.aborted) {
      return { turnText, turnToolCalls: [], promptTokensDelta, completionTokensDelta };
    }

    // 成功路径
    if (streamError === undefined && receivedComplete) {
      return { turnText, turnToolCalls, promptTokensDelta, completionTokensDelta };
    }

    // 流结束但未收到 complete 且无显式错误 → protocol error（不可重试）
    if (streamError === undefined && !receivedComplete) {
      const protoErr: PublicError = {
        code: 'protocol_error',
        message: 'Provider stream ended without response.complete event.',
        retryable: false,
      };
      closeSteerInput?.();
      yield { type: 'loop.failed', error: protoErr, iteration };
      return undefined;
    }

    // 有错误 — 检查是否可重试
    lastError = streamError!;
    if (!lastError.retryable) {
      closeSteerInput?.();
      yield { type: 'loop.failed', error: lastError, iteration };
      return undefined;
    }
    // 可重试 → 继续循环
  }

  // 超过重试上限
  closeSteerInput?.();
  yield { type: 'loop.failed', error: lastError!, iteration };
  return undefined;
}

/** 指数退避延迟计算（含 jitter） */
function computeRetryDelay(attempt: number, retry: RetryConfig): number {
  const exponential = retry.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, retry.maxDelayMs);
  // 添加 ±25% 随机 jitter 避免 thundering herd
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/** 可被 AbortSignal 中断的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────

function resolveRegistry(registry: ToolRegistry, mode: 'default' | 'plan'): ToolRegistry {
  if (mode === 'default') {
    return registry;
  }
  // Plan Mode：只注入 read 类工具（submit_plan 的 risk 是 read，自然包含在内）
  return registry.filterByRisk(['read']);
}

function formatSteerGuidance(items: readonly import('./types.js').SteerGuidance[]): ProviderMessage {
  const lines = items.map((item, index) => `${index + 1}. ${item.text}`);
  return {
    role: 'user',
    content: `<steer-guidance>\n${lines.join('\n')}\n</steer-guidance>`,
    provenance: 'steer',
  };
}

function serializeToolResult(result: ToolExecutionResult): string {
  if (result.ok) {
    try {
      return JSON.stringify(result.data);
    } catch {
      return '[Tool result could not be serialized]';
    }
  }
  return `Error: ${result.error.message}`;
}
