import { describe, expect, it } from 'vitest';

import { checkStopCondition } from '../../../src/agent/stopCondition.js';
import type { StopConditionContext } from '../../../src/agent/types.js';

function makeContext(overrides: Partial<StopConditionContext> = {}): StopConditionContext {
  return {
    iteration: 1,
    maxIterations: 50,
    consecutiveUnknownTools: 0,
    maxConsecutiveUnknownTools: 3,
    hasToolCalls: true,
    hasError: false,
    ...overrides,
  };
}

describe('checkStopCondition', () => {
  // ─── 基本触发 ─────────────────────────────────────────────────────

  it('返回 natural 当模型没有工具调用（纯文本完成）', () => {
    const ctx = makeContext({ hasToolCalls: false });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'natural' });
  });

  it('返回 max_iterations 当迭代达到上限', () => {
    const ctx = makeContext({ iteration: 50, maxIterations: 50 });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'max_iterations' });
  });

  it('返回 cancelled 当 signal 已 aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext({ signal: controller.signal });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'cancelled' });
  });

  it('返回 unknown_tool_limit 当连续未知工具达到阈值', () => {
    const ctx = makeContext({ consecutiveUnknownTools: 3, maxConsecutiveUnknownTools: 3 });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'unknown_tool_limit' });
  });

  it('返回 provider_error 当有 provider 错误', () => {
    const ctx = makeContext({ hasError: true });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'provider_error' });
  });

  // ─── 不停止的场景 ─────────────────────────────────────────────────

  it('返回 stop: false 当所有条件都不满足', () => {
    const ctx = makeContext();
    expect(checkStopCondition(ctx)).toEqual({ stop: false });
  });

  it('返回 stop: false 当 iteration 未到上限且有工具调用', () => {
    const ctx = makeContext({ iteration: 49, maxIterations: 50 });
    expect(checkStopCondition(ctx)).toEqual({ stop: false });
  });

  it('返回 stop: false 当 consecutiveUnknownTools 低于阈值', () => {
    const ctx = makeContext({ consecutiveUnknownTools: 2, maxConsecutiveUnknownTools: 3 });
    expect(checkStopCondition(ctx)).toEqual({ stop: false });
  });

  // ─── 优先级 ───────────────────────────────────────────────────────

  it('cancelled 优先于 provider_error', () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext({ signal: controller.signal, hasError: true });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'cancelled' });
  });

  it('cancelled 优先于 natural', () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext({ signal: controller.signal, hasToolCalls: false });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'cancelled' });
  });

  it('cancelled 优先于 max_iterations', () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext({ signal: controller.signal, iteration: 50, maxIterations: 50 });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'cancelled' });
  });

  it('provider_error 优先于 natural', () => {
    const ctx = makeContext({ hasError: true, hasToolCalls: false });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'provider_error' });
  });

  it('natural 优先于 unknown_tool_limit', () => {
    // 没有工具调用时，即使 unknownTools 达到阈值也应该是 natural
    const ctx = makeContext({
      hasToolCalls: false,
      consecutiveUnknownTools: 3,
      maxConsecutiveUnknownTools: 3,
    });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'natural' });
  });

  it('unknown_tool_limit 优先于 max_iterations', () => {
    const ctx = makeContext({
      consecutiveUnknownTools: 3,
      maxConsecutiveUnknownTools: 3,
      iteration: 50,
      maxIterations: 50,
    });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'unknown_tool_limit' });
  });

  // ─── 边界值 ───────────────────────────────────────────────────────

  it('iteration 恰好等于 maxIterations 时触发 max_iterations', () => {
    const ctx = makeContext({ iteration: 3, maxIterations: 3 });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'max_iterations' });
  });

  it('iteration 小于 maxIterations 时不触发', () => {
    const ctx = makeContext({ iteration: 2, maxIterations: 3 });
    expect(checkStopCondition(ctx)).toEqual({ stop: false });
  });

  it('consecutiveUnknownTools 恰好等于阈值时触发', () => {
    const ctx = makeContext({ consecutiveUnknownTools: 3, maxConsecutiveUnknownTools: 3 });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'unknown_tool_limit' });
  });

  it('consecutiveUnknownTools 超过阈值时也触发', () => {
    const ctx = makeContext({ consecutiveUnknownTools: 5, maxConsecutiveUnknownTools: 3 });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'unknown_tool_limit' });
  });

  it('空文本 + 无工具调用 = natural（不是 error）', () => {
    const ctx = makeContext({ hasToolCalls: false, hasError: false });
    expect(checkStopCondition(ctx)).toEqual({ stop: true, reason: 'natural' });
  });

  it('signal 不存在时不触发 cancelled', () => {
    const { signal: _, ...rest } = makeContext();
    const ctx: StopConditionContext = rest;
    expect(checkStopCondition(ctx)).toEqual({ stop: false });
  });

  it('signal 未 aborted 时不触发 cancelled', () => {
    const controller = new AbortController();
    const ctx = makeContext({ signal: controller.signal });
    expect(checkStopCondition(ctx)).toEqual({ stop: false });
  });
});
