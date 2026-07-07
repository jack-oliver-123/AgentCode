import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '../../../src/agent/AgentLoop.js';
import type { AgentLoopConfig, AgentLoopDeps, AgentLoopEvent, AgentLoopInput } from '../../../src/agent/types.js';
import { DEFAULT_AGENT_LOOP_CONFIG } from '../../../src/agent/types.js';
import type { ProviderEvent } from '../../../src/providers/types.js';
import type { ToolDefinition, ToolExecutionContext, ToolRegistry, ToolRisk } from '../../../src/tools/types.js';
import { FakeProvider, collectEvents } from '../../helpers/FakeProvider.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function makeTool(name: string, risk: ToolRisk, result: unknown = { done: true }): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk,
    validate: (input: unknown) => ({ ok: true, value: input }),
    execute: async () => ({
      ok: true as const,
      toolName: name,
      data: result,
      meta: { durationMs: 1, timedOut: false },
    }),
  };
}

function makeRegistry(tools: ToolDefinition[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => tools,
    get: (name) => map.get(name),
    getProviderDeclarations: () =>
      tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    filterByRisk: (risks) => {
      const allowed = new Set(risks);
      return makeRegistry(tools.filter((t) => allowed.has(t.risk)));
    },
  };
}

function makeInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    contextMessages: [],
    userMessage: { role: 'user', content: 'Do something' },
    mode: 'full',
    ...overrides,
  };
}

function makeDeps(
  provider: FakeProvider,
  registry?: ToolRegistry,
  configOverrides: Partial<AgentLoopConfig> = {}
): AgentLoopDeps {
  return {
    provider,
    toolRegistry: registry ?? makeRegistry([makeTool('read_file', 'read'), makeTool('write_file', 'write')]),
    createToolContext: (signal?: AbortSignal): ToolExecutionContext => ({
      cwd: '/tmp',
      timeoutMs: 5000,
      secrets: [],
      maxOutputBytes: 10000,
      ...(signal !== undefined ? { signal } : {}),
    }),
    config: { ...DEFAULT_AGENT_LOOP_CONFIG, ...configOverrides },
    model: 'test-model',
    thinking: { enabled: false },
  };
}

// 创建 tool.call 事件的 helper
function toolCall(name: string, args = '{}'): ProviderEvent {
  return { type: 'tool.call', call: { id: `call-${name}-${Date.now()}`, name, argumentsText: args } };
}

function complete(finishReason?: string): ProviderEvent {
  return finishReason ? { type: 'response.complete', finishReason } : { type: 'response.complete' };
}

function delta(text: string): ProviderEvent {
  return { type: 'content.delta', delta: text };
}

// ─── 正常完成 ─────────────────────────────────────────────────────────

describe('runAgentLoop - 正常完成', () => {
  it('单轮纯文本回答直接完成', async () => {
    const provider = new FakeProvider([
      [{ type: 'response.start' }, delta('Hello world'), complete('stop')],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput(), makeDeps(provider)));

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ type: 'loop.completed', finalText: 'Hello world', reason: 'natural', totalIterations: 1 });
    expect(events.filter((e) => e.type === 'text.delta')).toHaveLength(1);
  });

  it('多步工具调用后返回最终文本', async () => {
    const provider = new FakeProvider([
      // 第 1 轮：调用 read_file
      [{ type: 'response.start' }, toolCall('read_file', '{"path":"a.ts"}'), complete('tool_calls')],
      // 第 2 轮：调用 write_file
      [{ type: 'response.start' }, toolCall('write_file', '{"path":"b.ts","content":"x"}'), complete('tool_calls')],
      // 第 3 轮：最终文本
      [{ type: 'response.start' }, delta('All done.'), complete('stop')],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput(), makeDeps(provider)));

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'natural', totalIterations: 3, finalText: 'All done.' });

    // 验证有 2 轮工具调用
    const toolStarts = events.filter((e) => e.type === 'tool_call.start');
    expect(toolStarts).toHaveLength(2);
    const toolResults = events.filter((e) => e.type === 'tool_call.result');
    expect(toolResults).toHaveLength(2);
  });

  it('事件流按正确顺序 yield', async () => {
    const provider = new FakeProvider([
      [{ type: 'response.start' }, delta('thinking...'), toolCall('read_file'), complete('tool_calls')],
      [{ type: 'response.start' }, delta('Done'), complete('stop')],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput(), makeDeps(provider)));
    const types = events.map((e) => e.type);

    // 第 1 轮
    expect(types[0]).toBe('iteration.start');
    expect(types[1]).toBe('text.delta');
    expect(types[2]).toBe('tool_call.start');
    expect(types[3]).toBe('tool_call.result');
    // 第 2 轮
    expect(types[4]).toBe('iteration.start');
    expect(types[5]).toBe('text.delta');
    expect(types[6]).toBe('loop.completed');
  });
});

// ─── 迭代上限 ─────────────────────────────────────────────────────────

describe('runAgentLoop - 迭代上限', () => {
  it('达到 maxIterations 时终止', async () => {
    // provider 永远返回工具调用
    const provider = new FakeProvider((_, callIndex) => {
      return [{ type: 'response.start' }, toolCall('read_file'), complete('tool_calls')];
    });

    const events = await collectEvents(
      runAgentLoop(makeInput(), makeDeps(provider, undefined, { maxIterations: 3 }))
    );

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'max_iterations', totalIterations: 3 });
  });
});

// ─── 用户取消 ─────────────────────────────────────────────────────────

describe('runAgentLoop - 取消', () => {
  it('signal 在启动前已 aborted 则立即退出', async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new FakeProvider([
      [{ type: 'response.start' }, delta('Never seen'), complete('stop')],
    ]);

    const events = await collectEvents(
      runAgentLoop(makeInput({ signal: controller.signal }), makeDeps(provider))
    );

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'cancelled' });
    // provider 不应被调用
    expect(provider.requests).toHaveLength(0);
  });

  it('signal 在迭代间 abort 时干净退出', async () => {
    const controller = new AbortController();
    let callCount = 0;

    // 第 1 轮返回工具调用完成后 abort，第 2 轮应被 abort 拦截
    const provider = new FakeProvider((request, callIndex) => {
      callCount++;
      if (callIndex === 0) {
        return [{ type: 'response.start' }, toolCall('read_file'), complete('tool_calls')];
      }
      return [{ type: 'response.start' }, delta('should not reach'), complete('stop')];
    });

    // 在工具执行时 abort（模拟用户在工具执行中取消）
    const deps = makeDeps(provider);
    const originalCreateToolContext = deps.createToolContext;
    deps.createToolContext = (signal?: AbortSignal) => {
      controller.abort();
      return originalCreateToolContext(signal);
    };

    const events = await collectEvents(
      runAgentLoop(makeInput({ signal: controller.signal }), deps)
    );

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'cancelled' });
    // provider 只应被调用 1 次
    expect(callCount).toBe(1);
  });
});

// ─── 连续未知工具 ─────────────────────────────────────────────────────

describe('runAgentLoop - 连续未知工具', () => {
  it('连续调用不存在工具达到阈值时终止', async () => {
    const provider = new FakeProvider((_, callIndex) => {
      return [{ type: 'response.start' }, toolCall('nonexistent_tool'), complete('tool_calls')];
    });

    const events = await collectEvents(
      runAgentLoop(makeInput(), makeDeps(provider, undefined, { maxConsecutiveUnknownTools: 3 }))
    );

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'unknown_tool_limit' });
  });

  it('混合调用中有已知工具时 unknownTools 计数重置', async () => {
    const provider = new FakeProvider((_, callIndex) => {
      if (callIndex === 0) {
        // 第 1 轮：未知工具
        return [{ type: 'response.start' }, toolCall('fake_tool'), complete('tool_calls')];
      }
      if (callIndex === 1) {
        // 第 2 轮：已知工具（重置计数）
        return [{ type: 'response.start' }, toolCall('read_file'), complete('tool_calls')];
      }
      if (callIndex === 2) {
        // 第 3 轮：未知工具（计数从 0 重新开始）
        return [{ type: 'response.start' }, toolCall('fake_tool_2'), complete('tool_calls')];
      }
      // 第 4 轮：完成
      return [{ type: 'response.start' }, delta('done'), complete('stop')];
    });

    const events = await collectEvents(
      runAgentLoop(makeInput(), makeDeps(provider, undefined, { maxConsecutiveUnknownTools: 2 }))
    );

    const completed = events.find((e) => e.type === 'loop.completed');
    // 不会因为 unknown_tool_limit 停止，因为中间有 read_file 重置了计数
    expect(completed).toMatchObject({ reason: 'natural' });
  });
});

// ─── Provider 错误 ────────────────────────────────────────────────────

describe('runAgentLoop - Provider 错误', () => {
  it('response.error 事件导致 loop.failed', async () => {
    const provider = new FakeProvider([
      [
        { type: 'response.start' },
        delta('partial'),
        { type: 'response.error', error: { code: 'provider_error', message: 'rate limit', retryable: true } },
      ],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput(), makeDeps(provider)));

    const failed = events.find((e) => e.type === 'loop.failed');
    expect(failed).toBeDefined();
    if (failed && failed.type === 'loop.failed') {
      expect(failed.error.message).toBe('rate limit');
      expect(failed.iteration).toBe(1);
    }
  });

  it('stream 无 response.complete 时 yield loop.failed', async () => {
    // provider stream 直接结束，不发 response.complete
    const provider = new FakeProvider([
      [{ type: 'response.start' }, delta('partial')],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput(), makeDeps(provider)));

    const failed = events.find((e) => e.type === 'loop.failed');
    expect(failed).toBeDefined();
    if (failed && failed.type === 'loop.failed') {
      expect(failed.error.code).toBe('protocol_error');
    }
  });
});

// ─── 多工具并发 ───────────────────────────────────────────────────────

describe('runAgentLoop - 多工具并发', () => {
  it('一次返回多个工具调用，read 并发 write 串行', async () => {
    const executionOrder: string[] = [];
    const tools: ToolDefinition[] = [
      {
        ...makeTool('read_file', 'read'),
        execute: async () => {
          executionOrder.push('read_file');
          return { ok: true as const, toolName: 'read_file', data: {}, meta: { durationMs: 0, timedOut: false } };
        },
      },
      {
        ...makeTool('glob_files', 'read'),
        execute: async () => {
          executionOrder.push('glob_files');
          return { ok: true as const, toolName: 'glob_files', data: {}, meta: { durationMs: 0, timedOut: false } };
        },
      },
      {
        ...makeTool('write_file', 'write'),
        execute: async () => {
          executionOrder.push('write_file');
          return { ok: true as const, toolName: 'write_file', data: {}, meta: { durationMs: 0, timedOut: false } };
        },
      },
    ];
    const registry = makeRegistry(tools);

    const provider = new FakeProvider([
      // 一次返回 2 read + 1 write
      [
        { type: 'response.start' },
        { type: 'tool.call', call: { id: 'c1', name: 'read_file', argumentsText: '{}' } },
        { type: 'tool.call', call: { id: 'c2', name: 'glob_files', argumentsText: '{}' } },
        { type: 'tool.call', call: { id: 'c3', name: 'write_file', argumentsText: '{}' } },
        complete('tool_calls'),
      ],
      // 第 2 轮：最终回答
      [{ type: 'response.start' }, delta('Done'), complete('stop')],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput(), makeDeps(provider, registry)));

    // 验证 3 个 tool_call.start 和 3 个 tool_call.result
    expect(events.filter((e) => e.type === 'tool_call.start')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'tool_call.result')).toHaveLength(3);

    // read 工具在 write 之前执行（因为 read batch 在前）
    const readIdx = Math.max(executionOrder.indexOf('read_file'), executionOrder.indexOf('glob_files'));
    const writeIdx = executionOrder.indexOf('write_file');
    expect(readIdx).toBeLessThan(writeIdx);
  });
});

// ─── Plan Mode ────────────────────────────────────────────────────────

describe('runAgentLoop - Plan Mode', () => {
  it('/plan 模式只注入 read 类工具', async () => {
    const provider = new FakeProvider([
      [{ type: 'response.start' }, delta('Here is my plan'), complete('stop')],
    ]);

    const registry = makeRegistry([makeTool('read_file', 'read'), makeTool('write_file', 'write')]);
    const deps = makeDeps(provider, registry);

    await collectEvents(runAgentLoop(makeInput({ mode: 'plan' }), deps));

    // 验证 provider 收到的 tools 只有 read 类
    const request = provider.requests[0]!;
    const toolNames = request.tools!.map((t) => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).not.toContain('write_file');
  });

  it('submit_plan 工具输出后 yield plan.submitted 并结束循环', async () => {
    const submitPlanTool = makeTool('submit_plan', 'read');
    submitPlanTool.execute = async (input: unknown) => ({
      ok: true as const,
      toolName: 'submit_plan',
      data: input,
      meta: { durationMs: 0, timedOut: false },
    });

    const registry = makeRegistry([makeTool('read_file', 'read'), submitPlanTool]);

    const planSteps = JSON.stringify({ steps: [{ title: 'Step 1', description: 'Do thing' }] });
    const provider = new FakeProvider([
      [
        { type: 'response.start' },
        { type: 'tool.call', call: { id: 'plan-1', name: 'submit_plan', argumentsText: planSteps } },
        complete('tool_calls'),
      ],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput({ mode: 'plan' }), makeDeps(provider, registry)));

    const planEvent = events.find((e) => e.type === 'plan.submitted');
    expect(planEvent).toBeDefined();
    if (planEvent && planEvent.type === 'plan.submitted') {
      expect(planEvent.steps).toEqual([{ title: 'Step 1', description: 'Do thing' }]);
    }

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'natural' });
  });

  it('Plan Mode 中模型不调用 submit_plan 而返回纯文本时正常完成', async () => {
    const registry = makeRegistry([makeTool('read_file', 'read'), makeTool('submit_plan', 'read')]);
    const provider = new FakeProvider([
      [{ type: 'response.start' }, delta('No plan, just text.'), complete('stop')],
    ]);

    const events = await collectEvents(runAgentLoop(makeInput({ mode: 'plan' }), makeDeps(provider, registry)));

    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'natural', finalText: 'No plan, just text.' });
    expect(events.find((e) => e.type === 'plan.submitted')).toBeUndefined();
  });
});

// ─── 上下文正确性 ─────────────────────────────────────────────────────

describe('runAgentLoop - 上下文正确性', () => {
  it('每次 provider.stream 包含本 turn 全部已完成工具调用和结果', async () => {
    const provider = new FakeProvider([
      // 第 1 轮：调用 read_file
      [
        { type: 'response.start' },
        { type: 'tool.call', call: { id: 'c1', name: 'read_file', argumentsText: '{}' } },
        complete('tool_calls'),
      ],
      // 第 2 轮：调用 write_file
      [
        { type: 'response.start' },
        { type: 'tool.call', call: { id: 'c2', name: 'write_file', argumentsText: '{}' } },
        complete('tool_calls'),
      ],
      // 第 3 轮：最终回答
      [{ type: 'response.start' }, delta('All done'), complete('stop')],
    ]);

    await collectEvents(runAgentLoop(makeInput(), makeDeps(provider)));

    // 第 2 次请求应包含第 1 轮的 assistant+toolCalls 和 tool result
    const secondRequest = provider.requests[1]!;
    const messages = secondRequest.messages;
    // 原始 user message + assistant tool call + tool result
    expect(messages.length).toBeGreaterThanOrEqual(3);
    // 最后两条应是 assistant(toolCalls) 和 tool result
    const assistantMsg = messages[messages.length - 2]!;
    expect(assistantMsg.role).toBe('assistant');
    expect('toolCalls' in assistantMsg).toBe(true);

    const toolResultMsg = messages[messages.length - 1]!;
    expect(toolResultMsg.role).toBe('tool');

    // 第 3 次请求应包含两轮的工具历史
    const thirdRequest = provider.requests[2]!;
    const toolResultMessages = thirdRequest.messages.filter((m) => m.role === 'tool');
    expect(toolResultMessages).toHaveLength(2);
  });
});

// ─── 非法 JSON argumentsText ──────────────────────────────────────────

describe('runAgentLoop - 边界情况', () => {
  it('非法 JSON argumentsText 不触发 unknownTool 计数', async () => {
    const provider = new FakeProvider([
      // 第 1 轮：已知工具但 args 非法
      [
        { type: 'response.start' },
        { type: 'tool.call', call: { id: 'c1', name: 'read_file', argumentsText: 'not json!' } },
        complete('tool_calls'),
      ],
      // 第 2 轮：正常完成
      [{ type: 'response.start' }, delta('Done'), complete('stop')],
    ]);

    const events = await collectEvents(
      runAgentLoop(makeInput(), makeDeps(provider, undefined, { maxConsecutiveUnknownTools: 1 }))
    );

    // 应该正常完成而非因 unknown_tool_limit 终止
    const completed = events.find((e) => e.type === 'loop.completed');
    expect(completed).toMatchObject({ reason: 'natural' });
  });
});
