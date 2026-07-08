import type {
  AgentLoopDeps,
  AgentLoopEvent,
  AgentLoopInput,
  PlanStep,
  ProviderMessage,
  ProviderToolCall,
  ToolExecutionResult,
} from './types.js';
import type { ProviderEvent, ProviderRequest } from '../providers/types.js';
import type { ToolRegistry } from '../tools/types.js';
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
  deps: AgentLoopDeps
): AsyncGenerator<AgentLoopEvent, void, undefined> {
  const { provider, toolRegistry, createToolContext, config, model, thinking } = deps;
  const { signal } = input;

  // 根据 mode 过滤工具集
  const activeRegistry = resolveRegistry(toolRegistry, input.mode);

  // reminder 注入：创建临时副本，不 mutate 原始 input.userMessage
  const effectiveUserMessage = (input.reminder && input.reminder.length > 0)
    ? { ...input.userMessage, content: `<system-reminder>\n${input.reminder}\n</system-reminder>\n\n${input.userMessage.content}` }
    : input.userMessage;

  // 构建初始消息数组
  const messages: ProviderMessage[] = [
    ...input.contextMessages,
    effectiveUserMessage,
  ];

  // 记录初始消息数量，后续新增的就是 turnMessages
  const initialMessageCount = messages.length;

  // 工具声明在循环内不变，提前计算
  const declarations = enhanceToolDeclarations(activeRegistry.getProviderDeclarations());

  let iteration = 0;
  let consecutiveUnknownTools = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  while (iteration < config.maxIterations) {
    iteration++;

    yield { type: 'iteration.start', iteration, maxIterations: config.maxIterations };

    // 检查 signal — 可能在迭代之间被取消
    if (signal?.aborted) {
      yield { type: 'loop.completed', finalText: '', totalIterations: iteration, reason: 'cancelled', turnMessages: messages.slice(initialMessageCount) };
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

    // 流式收集本轮 LLM 响应（双路：yield delta + 累积）
    let turnText = '';
    let turnThinkingText = '';
    const turnToolCalls: ProviderToolCall[] = [];
    let hasError = false;
    let receivedComplete = false;

    try {
      for await (const event of provider.stream(request)) {
        switch (event.type) {
          case 'content.delta':
            turnText += event.delta;
            yield { type: 'text.delta', delta: event.delta };
            break;

          case 'thinking.delta':
            turnThinkingText += event.delta;
            yield { type: 'thinking.delta', delta: event.delta };
            break;

          case 'tool.call':
            turnToolCalls.push(event.call);
            break;

          case 'response.complete':
            receivedComplete = true;
            break;

          case 'response.usage': {
            const promptTokens = typeof event.usage.inputTokens === 'number' ? event.usage.inputTokens : undefined;
            const completionTokens = typeof event.usage.outputTokens === 'number' ? event.usage.outputTokens : undefined;
            if (promptTokens !== undefined) totalPromptTokens += promptTokens;
            if (completionTokens !== undefined) totalCompletionTokens += completionTokens;
            yield {
              type: 'token.usage',
              ...(promptTokens !== undefined ? { promptTokens } : {}),
              ...(completionTokens !== undefined ? { completionTokens } : {}),
              totalPromptTokens,
              totalCompletionTokens,
            };
            break;
          }

          case 'response.error':
            hasError = true;
            yield { type: 'loop.failed', error: event.error, iteration };
            return;

          // response.start 忽略
          default:
            break;
        }
      }
    } catch (error) {
      yield { type: 'loop.failed', error: toPublicError(error), iteration };
      return;
    }

    // 流结束后检查：未收到 response.complete 视为 protocol error
    if (!receivedComplete && !hasError) {
      yield {
        type: 'loop.failed',
        error: {
          code: 'protocol_error',
          message: 'Provider stream ended without response.complete event.',
          retryable: false,
        },
        iteration,
      };
      return;
    }

    // 停止条件判断
    const hasToolCalls = turnToolCalls.length > 0;
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
      yield { type: 'loop.completed', finalText: turnText, totalIterations: iteration, reason, turnMessages: messages.slice(initialMessageCount) };
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
        yield { type: 'loop.completed', finalText: turnText, totalIterations: iteration, reason, turnMessages: messages.slice(initialMessageCount) };
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

      // 检查 submit_plan
      const planResult = allResults.find(
        (r) => r.call.name === SUBMIT_PLAN_TOOL_NAME && r.result.ok
      );
      if (planResult && planResult.result.ok) {
        const steps = (planResult.result.data as { steps: PlanStep[] }).steps;
        yield { type: 'plan.submitted', steps };
        yield { type: 'loop.completed', finalText: turnText, totalIterations: iteration, reason: 'natural', turnMessages: messages.slice(initialMessageCount) };
        return;
      }

      // 将 assistant 消息 + tool results 追加到 messages
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

      // 继续下一轮
      continue;
    }

    // 兜底：无工具调用已在上面 decision 处理，此处不应到达
    yield { type: 'loop.completed', finalText: turnText, totalIterations: iteration, reason: 'natural', turnMessages: messages.slice(initialMessageCount) };
    return;
  }

  // 达到迭代上限
  yield { type: 'loop.completed', finalText: '', totalIterations: iteration, reason: 'max_iterations', turnMessages: messages.slice(initialMessageCount) };
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────

function resolveRegistry(registry: ToolRegistry, mode: 'full' | 'plan'): ToolRegistry {
  if (mode === 'full') {
    return registry;
  }
  // Plan Mode：只注入 read 类工具（submit_plan 的 risk 是 read，自然包含在内）
  return registry.filterByRisk(['read']);
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
