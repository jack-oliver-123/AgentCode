import type { ProviderToolCall, ToolExecutionContext, ToolExecutionResult, ToolRegistry } from '../tools/types.js';
import { executeToolCall } from '../tools/executor.js';
import { toPublicError } from '../shared/errors.js';
import type { ToolBatch } from './types.js';

/**
 * 按工具 risk 分批：read 类并发，write/execute 类串行，未知工具直接返回 error
 */
export function createBatches(
  calls: ProviderToolCall[],
  registry: ToolRegistry
): { batches: ToolBatch[]; unknownResults: Array<{ call: ProviderToolCall; result: ToolExecutionResult }> } {
  if (calls.length === 0) {
    return { batches: [], unknownResults: [] };
  }

  const readCalls: ProviderToolCall[] = [];
  const sequentialCalls: ProviderToolCall[] = [];
  const unknownResults: Array<{ call: ProviderToolCall; result: ToolExecutionResult }> = [];

  for (const call of calls) {
    const tool = registry.get(call.name);
    if (tool === undefined) {
      // 未知工具直接产出 error，不进 batch
      unknownResults.push({
        call,
        result: {
          ok: false,
          toolName: call.name,
          error: {
            code: 'unknown_tool',
            message: `Tool "${call.name}" is not registered.`,
            retryable: false,
          },
          meta: { durationMs: 0, timedOut: false },
        },
      });
    } else if (tool.risk === 'read') {
      readCalls.push(call);
    } else {
      sequentialCalls.push(call);
    }
  }

  const batches: ToolBatch[] = [];

  // concurrent batch 在前
  if (readCalls.length > 0) {
    batches.push({ calls: readCalls, mode: 'concurrent' });
  }

  // sequential batch 按原始顺序，每个工具一个 batch
  for (const call of sequentialCalls) {
    batches.push({ calls: [call], mode: 'sequential' });
  }

  return { batches, unknownResults };
}

/**
 * 执行所有 batch，返回全部结果（按原始调用顺序排列）
 */
export async function executeBatches(
  batches: ToolBatch[],
  registry: ToolRegistry,
  context: ToolExecutionContext
): Promise<Array<{ call: ProviderToolCall; result: ToolExecutionResult; durationMs: number }>> {
  const results: Array<{ call: ProviderToolCall; result: ToolExecutionResult; durationMs: number }> = [];

  for (const batch of batches) {
    // abort 后后续 batch 不再开始
    if (context.signal?.aborted) {
      for (const call of batch.calls) {
        results.push({
          call,
          result: {
            ok: false,
            toolName: call.name,
            error: {
              code: 'tool_internal_error',
              message: 'Execution cancelled.',
              retryable: false,
            },
            meta: { durationMs: 0, timedOut: false },
          },
          durationMs: 0,
        });
      }
      continue;
    }

    if (batch.mode === 'concurrent') {
      const settled = await Promise.allSettled(
        batch.calls.map(async (call) => {
          const start = Date.now();
          const result = await executeToolCall(call, registry, context);
          return { call, result, durationMs: Date.now() - start };
        })
      );

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i]!;
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value);
        } else {
          // 不应发生（executeToolCall 内部 catch），但防御性处理
          const batchCall = batch.calls[i]!;
          const publicError = toPublicError(outcome.reason);
          results.push({
            call: batchCall,
            result: {
              ok: false,
              toolName: batchCall.name,
              error: {
                code: 'tool_internal_error',
                message: publicError.message,
                retryable: false,
              },
              meta: { durationMs: 0, timedOut: false },
            },
            durationMs: 0,
          });
        }
      }
    } else {
      // sequential: 逐个执行
      for (const call of batch.calls) {
        if (context.signal?.aborted) {
          results.push({
            call,
            result: {
              ok: false,
              toolName: call.name,
              error: {
                code: 'tool_internal_error',
                message: 'Execution cancelled.',
                retryable: false,
              },
              meta: { durationMs: 0, timedOut: false },
            },
            durationMs: 0,
          });
          continue;
        }

        const start = Date.now();
        const result = await executeToolCall(call, registry, context);
        results.push({ call, result, durationMs: Date.now() - start });
      }
    }
  }

  return results;
}
