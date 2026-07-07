import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { executeToolCall } from '../../../src/tools/executor.js';
import type {
  ProviderToolCall,
  ProviderToolDeclaration,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  ToolValidationResult
} from '../../../src/tools/types.js';

const BASE_CONTEXT: ToolExecutionContext = {
  cwd: process.cwd(),
  timeoutMs: 100,
  secrets: [],
  maxOutputBytes: 1024
};

describe('executeToolCall', () => {
  it('parses JSON arguments, validates input, executes the selected tool, and records executor meta', async () => {
    const registry = createRegistry([
      createTestTool({
        name: 'read_file',
        validate: (input) => ({ ok: true, value: input as { path: string } }),
        execute: async (input) => ({
          ok: true,
          toolName: 'read_file',
          data: {
            path: input.path,
            signalProvided: true
          },
          meta: {
            durationMs: 999,
            timedOut: false
          }
        })
      })
    ]);

    const result = await executeToolCall(createCall('read_file', '{"path":"src/index.ts"}'), registry, BASE_CONTEXT);

    expect(result).toMatchObject({
      ok: true,
      toolName: 'read_file',
      data: {
        path: 'src/index.ts',
        signalProvided: true
      },
      meta: {
        timedOut: false
      }
    });
    expect(result.meta.durationMs).not.toBe(999);
  });

  it('returns invalid_arguments when tool arguments are not valid JSON', async () => {
    const result = await executeToolCall(createCall('read_file', '{bad json'), createRegistry([]), BASE_CONTEXT);

    expect(result).toMatchObject({
      ok: false,
      toolName: 'read_file',
      error: {
        code: 'invalid_arguments',
        retryable: true
      },
      meta: {
        timedOut: false
      }
    });
  });

  it('returns unknown_tool when the registry does not contain the requested tool', async () => {
    const result = await executeToolCall(createCall('missing_tool', '{}'), createRegistry([]), BASE_CONTEXT);

    expect(result).toMatchObject({
      ok: false,
      toolName: 'missing_tool',
      error: {
        code: 'unknown_tool',
        retryable: false
      }
    });
  });

  it('returns validation errors without executing the tool', async () => {
    let executed = false;
    const registry = createRegistry([
      createTestTool({
        name: 'write_file',
        validate: () => ({
          ok: false,
          error: {
            code: 'invalid_arguments',
            message: 'path is required',
            retryable: true
          }
        }),
        execute: async () => {
          executed = true;
          return createSuccessResult('write_file', {});
        }
      })
    ]);

    const result = await executeToolCall(createCall('write_file', '{}'), registry, BASE_CONTEXT);

    expect(executed).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      toolName: 'write_file',
      error: {
        code: 'invalid_arguments',
        message: 'path is required',
        retryable: true
      }
    });
  });

  it('converts thrown validation errors into redacted tool_internal_error results', async () => {
    const secret = 'sk-agentcode-e2e-secret-should-not-appear';
    const registry = createRegistry([
      createTestTool({
        name: 'edit_file',
        validate: () => {
          throw new Error(`validator leaked ${secret}`);
        }
      })
    ]);

    const result = await executeToolCall(createCall('edit_file', '{}'), registry, {
      ...BASE_CONTEXT,
      secrets: [secret]
    });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'edit_file',
      error: {
        code: 'tool_internal_error',
        retryable: false
      },
      meta: {
        timedOut: false
      }
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('converts thrown tool errors into tool_internal_error results', async () => {
    const registry = createRegistry([
      createTestTool({
        name: 'search_code',
        execute: async () => {
          throw new Error('boom');
        }
      })
    ]);

    const result = await executeToolCall(createCall('search_code', '{}'), registry, BASE_CONTEXT);

    expect(result).toMatchObject({
      ok: false,
      toolName: 'search_code',
      error: {
        code: 'tool_internal_error',
        message: 'boom',
        retryable: false
      }
    });
  });

  it('returns command_timeout and aborts the tool signal when execution exceeds the context timeout', async () => {
    let observedSignal: AbortSignal | undefined;
    const registry = createRegistry([
      createTestTool({
        name: 'run_command',
        execute: async (_input, context) => {
          observedSignal = context.signal;
          await delay(50);
          return createSuccessResult('run_command', { exitCode: 0 });
        }
      })
    ]);

    const result = await executeToolCall(createCall('run_command', '{}'), registry, {
      ...BASE_CONTEXT,
      timeoutMs: 1
    });

    expect(observedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'command_timeout',
        retryable: true
      },
      meta: {
        timedOut: true
      }
    });
  });

  it('keeps timeout results stable when an abort-aware tool rejects on abort', async () => {
    const registry = createRegistry([
      createTestTool({
        name: 'run_command',
        execute: async (_input, context) =>
          new Promise<ToolExecutionResult>((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => reject(new Error('aborted by tool')), { once: true });
          })
      })
    ]);

    const result = await executeToolCall(createCall('run_command', '{}'), registry, {
      ...BASE_CONTEXT,
      timeoutMs: 1
    });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'command_timeout',
        retryable: true
      },
      meta: {
        timedOut: true
      }
    });
  });

  it('keeps timeout results stable when an abort-aware tool resolves on abort', async () => {
    const registry = createRegistry([
      createTestTool({
        name: 'run_command',
        execute: async (_input, context) =>
          new Promise<ToolExecutionResult>((resolve) => {
            context.signal?.addEventListener(
              'abort',
              () => resolve(createSuccessResult('run_command', { shouldNotWinRace: true })),
              { once: true }
            );
          })
      })
    ]);

    const result = await executeToolCall(createCall('run_command', '{}'), registry, {
      ...BASE_CONTEXT,
      timeoutMs: 1
    });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'command_timeout',
        retryable: true
      },
      meta: {
        timedOut: true
      }
    });
  });

  it('does not execute tools when the parent signal is already aborted', async () => {
    let executed = false;
    const abortController = new AbortController();
    abortController.abort();
    const registry = createRegistry([
      createTestTool({
        name: 'write_file',
        execute: async () => {
          executed = true;
          return createSuccessResult('write_file', {});
        }
      })
    ]);

    const result = await executeToolCall(createCall('write_file', '{}'), registry, {
      ...BASE_CONTEXT,
      signal: abortController.signal
    });

    expect(executed).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      toolName: 'write_file',
      error: {
        code: 'tool_internal_error',
        retryable: true
      },
      meta: {
        timedOut: false
      }
    });
  });

  it('does not report parent cancellation as a command timeout', async () => {
    const abortController = new AbortController();
    const registry = createRegistry([
      createTestTool({
        name: 'run_command',
        execute: async () => {
          await delay(50);
          return createSuccessResult('run_command', { exitCode: 0 });
        }
      })
    ]);

    const resultPromise = executeToolCall(createCall('run_command', '{}'), registry, {
      ...BASE_CONTEXT,
      timeoutMs: 100,
      signal: abortController.signal
    });
    abortController.abort();

    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'tool_internal_error',
        retryable: true
      },
      meta: {
        timedOut: false
      }
    });
  });

  it('keeps parent cancellation stable when an abort-aware tool resolves on abort', async () => {
    const abortController = new AbortController();
    const registry = createRegistry([
      createTestTool({
        name: 'run_command',
        execute: async (_input, context) =>
          new Promise<ToolExecutionResult>((resolve) => {
            context.signal?.addEventListener(
              'abort',
              () => resolve(createSuccessResult('run_command', { shouldNotWinRace: true })),
              { once: true }
            );
          })
      })
    ]);

    const resultPromise = executeToolCall(createCall('run_command', '{}'), registry, {
      ...BASE_CONTEXT,
      timeoutMs: 100,
      signal: abortController.signal
    });
    abortController.abort();

    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'tool_internal_error',
        retryable: true
      },
      meta: {
        timedOut: false
      }
    });
  });

  it('redacts secrets from successful and failed tool results before returning them', async () => {
    const secret = 'sk-agentcode-e2e-secret-should-not-appear';
    const registry = createRegistry([
      createTestTool({
        name: 'read_file',
        execute: async () =>
          createSuccessResult('read_file', {
            content: `secret=${secret}`
          })
      }),
      createTestTool({
        name: 'run_command',
        execute: async () => ({
          ok: false,
          toolName: 'run_command',
          error: {
            code: 'command_failed',
            message: `Authorization: Bearer ${secret}`,
            retryable: false
          },
          meta: {
            durationMs: 1,
            timedOut: false
          }
        })
      })
    ]);

    const successResult = await executeToolCall(createCall('read_file', '{}'), registry, {
      ...BASE_CONTEXT,
      secrets: [secret]
    });
    const failedResult = await executeToolCall(createCall('run_command', '{}'), registry, {
      ...BASE_CONTEXT,
      secrets: [secret]
    });

    expect(JSON.stringify(successResult)).not.toContain(secret);
    expect(JSON.stringify(failedResult)).not.toContain(secret);
    expect(JSON.stringify(failedResult)).toContain('<redacted>');
  });
});

function createCall(name: string, argumentsText: string): ProviderToolCall {
  return {
    id: `call-${name}`,
    name,
    argumentsText
  };
}

interface TestToolOptions<TInput = unknown> {
  name: string;
  validate?: (input: unknown) => ToolValidationResult<TInput>;
  execute?: (input: TInput, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

function createTestTool<TInput = unknown>(options: TestToolOptions<TInput>): ToolDefinition<TInput> {
  return {
    name: options.name,
    description: `${options.name} test tool`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    risk: 'read',
    validate: options.validate ?? ((input: unknown) => ({ ok: true, value: input as TInput })),
    execute: options.execute ?? (async () => createSuccessResult(options.name, {}))
  };
}

function createSuccessResult(toolName: string, data: unknown): ToolExecutionResult {
  return {
    ok: true,
    toolName,
    data,
    meta: {
      durationMs: 1,
      timedOut: false
    }
  };
}

function createRegistry(tools: ToolDefinition[]): ToolRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    list: () => tools,
    get: (name: string) => toolsByName.get(name),
    getProviderDeclarations: () => tools.map(createProviderDeclaration),
    filterByRisk: (allowedRisks) => {
      const allowed = new Set(allowedRisks);
      return createRegistry(tools.filter((t) => allowed.has(t.risk)));
    }
  };
}

function createProviderDeclaration(tool: ToolDefinition): ProviderToolDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}
