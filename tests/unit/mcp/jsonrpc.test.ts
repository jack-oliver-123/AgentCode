import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonRpcDispatcher } from '../../../src/mcp/jsonrpc.js';
import type { McpTransport } from '../../../src/mcp/transport/types.js';

function makeTransport(onSend?: (msg: string) => void): McpTransport {
  return {
    async send(message: string) {
      onSend?.(message);
    },
    async *messages() {
      // 不产出任何消息
    },
    async close() {},
  };
}

describe('JsonRpcDispatcher', () => {
  let dispatcher: JsonRpcDispatcher;

  beforeEach(() => {
    dispatcher = new JsonRpcDispatcher();
  });

  it('id 从 1 开始递增', async () => {
    const sent: string[] = [];
    const transport = makeTransport((msg) => sent.push(msg));

    // 发两个请求（不等待响应，让 Promise 挂起）
    const p1 = dispatcher.sendRequest(transport, 'method1');
    const p2 = dispatcher.sendRequest(transport, 'method2');

    // 立即 reject 所有 pending，防止测试挂起
    dispatcher.rejectAll(new Error('test'));
    await Promise.allSettled([p1, p2]);

    const req1 = JSON.parse(sent[0]!);
    const req2 = JSON.parse(sent[1]!);
    expect(req1.id).toBe(1);
    expect(req2.id).toBe(2);
    expect(req1.jsonrpc).toBe('2.0');
    expect(req2.jsonrpc).toBe('2.0');
  });

  it('dispatch 将响应路由到对应 pending 请求', async () => {
    const sent: string[] = [];
    const transport = makeTransport((msg) => sent.push(msg));

    const p1 = dispatcher.sendRequest(transport, 'ping');
    const id = JSON.parse(sent[0]!).id as number;

    // 模拟 Server 返回响应
    dispatcher.dispatch(JSON.stringify({ jsonrpc: '2.0', id, result: { pong: true } }));

    const result = await p1;
    expect(result).toEqual({ pong: true });
  });

  it('并发请求 id 各自独立路由', async () => {
    const sent: string[] = [];
    const transport = makeTransport((msg) => sent.push(msg));

    const p1 = dispatcher.sendRequest(transport, 'a');
    const p2 = dispatcher.sendRequest(transport, 'b');
    const p3 = dispatcher.sendRequest(transport, 'c');

    const id1 = JSON.parse(sent[0]!).id as number;
    const id2 = JSON.parse(sent[1]!).id as number;
    const id3 = JSON.parse(sent[2]!).id as number;

    // 乱序回包
    dispatcher.dispatch(JSON.stringify({ jsonrpc: '2.0', id: id3, result: 'c-result' }));
    dispatcher.dispatch(JSON.stringify({ jsonrpc: '2.0', id: id1, result: 'a-result' }));
    dispatcher.dispatch(JSON.stringify({ jsonrpc: '2.0', id: id2, result: 'b-result' }));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('a-result');
    expect(r2).toBe('b-result');
    expect(r3).toBe('c-result');
  });

  it('超时后 reject，pending 计数归零', async () => {
    const transport = makeTransport();
    const p = dispatcher.sendRequest(transport, 'slow', undefined, undefined, 50);

    await expect(p).rejects.toThrow('timed out');
    expect(dispatcher.pendingCount).toBe(0);
  });

  it('abort 信号 reject', async () => {
    const transport = makeTransport();
    const controller = new AbortController();
    const p = dispatcher.sendRequest(transport, 'abortable', undefined, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(dispatcher.pendingCount).toBe(0);
  });

  it('rejectAll 批量 reject 所有 pending', async () => {
    const transport = makeTransport();
    const p1 = dispatcher.sendRequest(transport, 'x');
    const p2 = dispatcher.sendRequest(transport, 'y');

    expect(dispatcher.pendingCount).toBe(2);
    dispatcher.rejectAll(new Error('transport closed'));

    await expect(p1).rejects.toThrow('transport closed');
    await expect(p2).rejects.toThrow('transport closed');
    expect(dispatcher.pendingCount).toBe(0);
  });

  it('错误响应 reject 对应 Promise', async () => {
    const sent: string[] = [];
    const transport = makeTransport((msg) => sent.push(msg));
    const p = dispatcher.sendRequest(transport, 'fail');
    const id = JSON.parse(sent[0]!).id as number;

    dispatcher.dispatch(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }),
    );

    await expect(p).rejects.toThrow('Method not found');
  });

  it('无法解析的消息静默丢弃', () => {
    expect(() => dispatcher.dispatch('not-json')).not.toThrow();
  });

  it('未知 id 的响应静默丢弃', () => {
    expect(() =>
      dispatcher.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 9999, result: 'x' })),
    ).not.toThrow();
  });

  it('sendNotification 发送无 id 消息', async () => {
    const sent: string[] = [];
    const transport = makeTransport((msg) => sent.push(msg));
    await dispatcher.sendNotification(transport, 'notifications/initialized');
    const msg = JSON.parse(sent[0]!);
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('notifications/initialized');
    expect('id' in msg).toBe(false);
  });
});
