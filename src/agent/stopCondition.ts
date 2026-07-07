import type { StopConditionContext, StopDecision } from './types.js';

/**
 * 停止条件判断（纯函数）
 *
 * 优先级：cancelled > provider_error > natural > unknown_tool_limit > max_iterations
 */
export function checkStopCondition(ctx: StopConditionContext): StopDecision {
  // 1. 用户取消（最高优先级）
  if (ctx.signal?.aborted) {
    return { stop: true, reason: 'cancelled' };
  }

  // 2. Provider 不可恢复错误
  if (ctx.hasError) {
    return { stop: true, reason: 'provider_error' };
  }

  // 3. 模型返回纯文本（正常完成）
  if (!ctx.hasToolCalls) {
    return { stop: true, reason: 'natural' };
  }

  // 4. 连续未知工具超限
  if (ctx.consecutiveUnknownTools >= ctx.maxConsecutiveUnknownTools) {
    return { stop: true, reason: 'unknown_tool_limit' };
  }

  // 5. 达到迭代上限
  if (ctx.iteration >= ctx.maxIterations) {
    return { stop: true, reason: 'max_iterations' };
  }

  // 以上都不满足，继续循环
  return { stop: false };
}
