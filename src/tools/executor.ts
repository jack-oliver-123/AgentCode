import { performance } from 'node:perf_hooks';

import { redactToolResult } from './redaction.js';
import type {
  ProviderToolCall,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionResult,
  ToolRegistry,
  ToolValidationResult,
} from './types.js';

export async function executeToolCall(
  call: ProviderToolCall,
  registry: ToolRegistry,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const startedAt = performance.now();

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(call.argumentsText) as unknown;
  } catch {
    return redactResult(createErrorResult(call.name, createInvalidJsonError(), startedAt, false), context);
  }

  const tool = registry.get(call.name);
  if (tool === undefined) {
    return redactResult(createErrorResult(call.name, createUnknownToolError(call.name), startedAt, false), context);
  }

  let validation: ToolValidationResult<unknown>;
  try {
    validation = tool.validate(parsedArguments);
  } catch (error) {
    return redactResult(createErrorResult(tool.name, createInternalError(error), startedAt, false), context);
  }

  if (!validation.ok) {
    return redactResult(createErrorResult(tool.name, validation.error, startedAt, false), context);
  }

  if (context.signal?.aborted) {
    return redactResult(createErrorResult(tool.name, createCancelledError(), startedAt, false), context);
  }

  const toolController = new AbortController();
  let timedOut = false;
  let parentAborted = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<ToolExecutionResult>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve(createTimeoutResult(tool.name, context.timeoutMs));
      toolController.abort();
    }, context.timeoutMs);
  });

  const cancellationPromise = new Promise<ToolExecutionResult>((resolve) => {
    abortListener = () => {
      parentAborted = true;
      resolve(createCancellationResult(tool.name));
      toolController.abort();
    };
    context.signal?.addEventListener('abort', abortListener, { once: true });
  });

  try {
    const result = await Promise.race([
      tool.execute(validation.value, {
        ...context,
        signal: toolController.signal,
      }),
      timeoutPromise,
      cancellationPromise,
    ]);

    return redactResult(
      {
        ...result,
        toolName: tool.name,
        meta: {
          ...result.meta,
          durationMs: elapsedMs(startedAt),
          timedOut: result.meta.timedOut || timedOut,
        },
      },
      context,
    );
  } catch (error) {
    if (timedOut) {
      return redactResult(
        createErrorResult(tool.name, createTimeoutError(context.timeoutMs), startedAt, true),
        context,
      );
    }

    if (parentAborted) {
      return redactResult(createErrorResult(tool.name, createCancelledError(), startedAt, false), context);
    }

    return redactResult(createErrorResult(tool.name, createInternalError(error), startedAt, false), context);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (abortListener !== undefined) {
      context.signal?.removeEventListener('abort', abortListener);
    }
  }
}

function createTimeoutResult(toolName: string, timeoutMs: number): ToolExecutionResult {
  return {
    ok: false,
    toolName,
    error: createTimeoutError(timeoutMs),
    meta: {
      durationMs: timeoutMs,
      timedOut: true,
    },
  };
}

function createCancellationResult(toolName: string): ToolExecutionResult {
  return {
    ok: false,
    toolName,
    error: createCancelledError(),
    meta: {
      durationMs: 0,
      timedOut: false,
    },
  };
}

function createInvalidJsonError(): ToolExecutionError {
  return {
    code: 'invalid_arguments',
    message: 'Tool arguments must be valid JSON.',
    retryable: true,
  };
}

function createUnknownToolError(toolName: string): ToolExecutionError {
  return {
    code: 'unknown_tool',
    message: `Unknown tool: ${toolName}.`,
    retryable: false,
  };
}

function createTimeoutError(timeoutMs: number): ToolExecutionError {
  return {
    code: 'command_timeout',
    message: `Tool execution timed out after ${timeoutMs}ms.`,
    retryable: true,
  };
}

function createCancelledError(): ToolExecutionError {
  return {
    code: 'tool_internal_error',
    message: 'Tool execution was cancelled before completion.',
    retryable: true,
  };
}

function createInternalError(error: unknown): ToolExecutionError {
  return {
    code: 'tool_internal_error',
    message: error instanceof Error ? error.message : 'Tool execution failed with an unknown error.',
    retryable: false,
  };
}

function createErrorResult(
  toolName: string,
  error: ToolExecutionError,
  startedAt: number,
  timedOut: boolean,
): ToolExecutionResult {
  return {
    ok: false,
    toolName,
    error,
    meta: {
      durationMs: elapsedMs(startedAt),
      timedOut,
    },
  };
}

function redactResult(result: ToolExecutionResult, context: ToolExecutionContext): ToolExecutionResult {
  return redactToolResult(result, context.secrets);
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
