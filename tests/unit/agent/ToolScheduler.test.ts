import { describe, expect, it, vi } from 'vitest';

import { createBatches, executeBatches } from '../../../src/agent/ToolScheduler.js';
import type { ProviderToolCall, ToolDefinition, ToolExecutionContext, ToolRegistry, ToolRisk } from '../../../src/tools/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function makeCall(name: string, id?: string): ProviderToolCall {
  return { id: id ?? `call-${name}`, name, argumentsText: '{}' };
}

function makeTool(name: string, risk: ToolRisk, delayMs = 0): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk,
    validate: (input: unknown) => ({ ok: true, value: input }),
    execute: async (_input, _ctx) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        ok: true,
        toolName: name,
        data: { executed: name },
        meta: { durationMs: delayMs, timedOut: false },
      };
    },
  };
}

function makeRegistry(tools: ToolDefinition[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => tools,
    get: (name) => map.get(name),
    getProviderDeclarations: () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    filterByRisk: (risks) => {
      const allowed = new Set(risks);
      return makeRegistry(tools.filter((t) => allowed.has(t.risk)));
    },
  };
}

function makeContext(signal?: AbortSignal): ToolExecutionContext {
  return {
    cwd: '/tmp',
    timeoutMs: 5000,
    secrets: [],
    maxOutputBytes: 10000,
    ...(signal !== undefined ? { signal } : {}),
  };
}

// ─── createBatches ─────────────────────────────────────────────────────

describe('createBatches', () => {
  it('纯 read 工具归入一个 concurrent batch', () => {
    const registry = makeRegistry([makeTool('read_file', 'read'), makeTool('glob_files', 'read')]);
    const calls = [makeCall('read_file'), makeCall('glob_files')];

    const { batches, unknownResults } = createBatches(calls, registry);

    expect(unknownResults).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.mode).toBe('concurrent');
    expect(batches[0]!.calls).toHaveLength(2);
  });

  it('纯 write/execute 工具各占一个 sequential batch', () => {
    const registry = makeRegistry([makeTool('write_file', 'write'), makeTool('run_command', 'execute')]);
    const calls = [makeCall('write_file'), makeCall('run_command')];

    const { batches, unknownResults } = createBatches(calls, registry);

    expect(unknownResults).toHaveLength(0);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.mode).toBe('sequential');
    expect(batches[0]!.calls[0]!.name).toBe('write_file');
    expect(batches[1]!.mode).toBe('sequential');
    expect(batches[1]!.calls[0]!.name).toBe('run_command');
  });

  it('混合工具：read 先并发，write 后串行', () => {
    const registry = makeRegistry([
      makeTool('read_file', 'read'),
      makeTool('glob_files', 'read'),
      makeTool('write_file', 'write'),
    ]);
    const calls = [makeCall('write_file'), makeCall('read_file'), makeCall('glob_files')];

    const { batches } = createBatches(calls, registry);

    expect(batches).toHaveLength(2);
    expect(batches[0]!.mode).toBe('concurrent');
    expect(batches[0]!.calls.map((c) => c.name)).toEqual(['read_file', 'glob_files']);
    expect(batches[1]!.mode).toBe('sequential');
    expect(batches[1]!.calls[0]!.name).toBe('write_file');
  });

  it('未知工具直接产出 error，不进 batch', () => {
    const registry = makeRegistry([makeTool('read_file', 'read')]);
    const calls = [makeCall('read_file'), makeCall('nonexistent')];

    const { batches, unknownResults } = createBatches(calls, registry);

    expect(batches).toHaveLength(1);
    expect(unknownResults).toHaveLength(1);
    expect(unknownResults[0]!.call.name).toBe('nonexistent');
    expect(unknownResults[0]!.result.ok).toBe(false);
    if (!unknownResults[0]!.result.ok) {
      expect(unknownResults[0]!.result.error.code).toBe('unknown_tool');
    }
  });

  it('空 calls 数组返回空结果', () => {
    const registry = makeRegistry([]);
    const { batches, unknownResults } = createBatches([], registry);

    expect(batches).toHaveLength(0);
    expect(unknownResults).toHaveLength(0);
  });
});

// ─── executeBatches ────────────────────────────────────────────────────

describe('executeBatches', () => {
  it('concurrent batch 中的工具并发执行', async () => {
    const executionOrder: string[] = [];
    const tools = [
      {
        ...makeTool('tool_a', 'read', 50),
        execute: async () => {
          executionOrder.push('a_start');
          await new Promise((r) => setTimeout(r, 50));
          executionOrder.push('a_end');
          return { ok: true as const, toolName: 'tool_a', data: {}, meta: { durationMs: 50, timedOut: false } };
        },
      },
      {
        ...makeTool('tool_b', 'read', 50),
        execute: async () => {
          executionOrder.push('b_start');
          await new Promise((r) => setTimeout(r, 50));
          executionOrder.push('b_end');
          return { ok: true as const, toolName: 'tool_b', data: {}, meta: { durationMs: 50, timedOut: false } };
        },
      },
    ];
    const registry = makeRegistry(tools as unknown as ToolDefinition[]);
    const batches = [{ calls: [makeCall('tool_a'), makeCall('tool_b')], mode: 'concurrent' as const }];

    await executeBatches(batches, registry, makeContext());

    // 并发执行意味着两个 start 在两个 end 之前
    expect(executionOrder.indexOf('a_start')).toBeLessThan(executionOrder.indexOf('a_end'));
    expect(executionOrder.indexOf('b_start')).toBeLessThan(executionOrder.indexOf('b_end'));
    // 两个都 start 后才有 end
    expect(executionOrder.indexOf('b_start')).toBeLessThan(executionOrder.indexOf('a_end'));
  });

  it('sequential batch 中的工具串行执行', async () => {
    const executionOrder: string[] = [];
    const tools = [
      {
        ...makeTool('tool_a', 'write'),
        execute: async () => {
          executionOrder.push('a');
          return { ok: true as const, toolName: 'tool_a', data: {}, meta: { durationMs: 0, timedOut: false } };
        },
      },
      {
        ...makeTool('tool_b', 'write'),
        execute: async () => {
          executionOrder.push('b');
          return { ok: true as const, toolName: 'tool_b', data: {}, meta: { durationMs: 0, timedOut: false } };
        },
      },
    ];
    const registry = makeRegistry(tools as unknown as ToolDefinition[]);
    const batches = [
      { calls: [makeCall('tool_a')], mode: 'sequential' as const },
      { calls: [makeCall('tool_b')], mode: 'sequential' as const },
    ];

    await executeBatches(batches, registry, makeContext());

    expect(executionOrder).toEqual(['a', 'b']);
  });

  it('abort 后后续 batch 不执行', async () => {
    const controller = new AbortController();
    const tools = [
      {
        ...makeTool('tool_a', 'write'),
        execute: async () => {
          controller.abort(); // 在第一个工具执行中 abort
          return { ok: true as const, toolName: 'tool_a', data: {}, meta: { durationMs: 0, timedOut: false } };
        },
      },
      makeTool('tool_b', 'write'),
    ];
    const registry = makeRegistry(tools as unknown as ToolDefinition[]);
    const batches = [
      { calls: [makeCall('tool_a')], mode: 'sequential' as const },
      { calls: [makeCall('tool_b')], mode: 'sequential' as const },
    ];

    const results = await executeBatches(batches, registry, makeContext(controller.signal));

    expect(results).toHaveLength(2);
    expect(results[0]!.result.ok).toBe(true);
    expect(results[1]!.result.ok).toBe(false);
    if (!results[1]!.result.ok) {
      expect(results[1]!.result.error.message).toContain('cancelled');
    }
  });

  it('返回结果包含 durationMs', async () => {
    const registry = makeRegistry([makeTool('read_file', 'read')]);
    const batches = [{ calls: [makeCall('read_file')], mode: 'concurrent' as const }];

    const results = await executeBatches(batches, registry, makeContext());

    expect(results).toHaveLength(1);
    expect(typeof results[0]!.durationMs).toBe('number');
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
