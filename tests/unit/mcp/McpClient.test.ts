import { describe, it, expect } from 'vitest';
import { createMcpClient } from '../../../src/mcp/McpClient.js';
import type { McpTransport } from '../../../src/mcp/transport/types.js';

/** 构建一个可控制的 mock transport */
function makeControllableTransport() {
  const outbox: string[] = [];
  const inbox: string[] = [];
  let closed = false;
  const waiters: Array<() => void> = [];

  function push(msg: string) {
    inbox.push(msg);
    const waiter = waiters.shift();
    if (waiter) waiter();
  }

  const transport: McpTransport = {
    async send(message: string) {
      if (closed) throw new Error('closed');
      outbox.push(message);
    },
    async *messages() {
      while (true) {
        while (inbox.length > 0) yield inbox.shift()!;
        if (closed) break;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    async close() {
      closed = true;
      for (const w of waiters.splice(0)) w();
    },
  };

  return { transport, push, outbox, closeFn: () => { closed = true; for (const w of waiters.splice(0)) w(); } };
}

describe('McpClient', () => {
  it('connect 发送 initialize 请求并发送 initialized 通知', async () => {
    const { transport, push, outbox } = makeControllableTransport();
    const client = createMcpClient({ serverName: 'test', transport });

    // 在 connect 等待 initialize 响应时，异步回复
    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));

    // 找到 initialize 请求的 id
    const initReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'initialize')!);
    push(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: { protocolVersion: '2024-11-05' } }));

    await connectPromise;

    // 验证发送了 initialize 请求和 initialized 通知
    const methods = outbox.map((m) => JSON.parse(m).method);
    expect(methods).toContain('initialize');
    expect(methods).toContain('notifications/initialized');

    // initialized 通知无 id
    const initNotification = outbox.find((m) => JSON.parse(m).method === 'notifications/initialized');
    expect(JSON.parse(initNotification!).id).toBeUndefined();

    await client.close();
  });

  it('listTools 返回工具数组', async () => {
    const { transport, push, outbox } = makeControllableTransport();
    const client = createMcpClient({ serverName: 'test', transport });

    // 先 connect
    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'initialize')!);
    push(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: {} }));
    await connectPromise;

    // listTools
    const listPromise = client.listTools();
    await new Promise((r) => setTimeout(r, 10));
    const listReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'tools/list')!);
    push(JSON.stringify({
      jsonrpc: '2.0', id: listReq.id,
      result: { tools: [{ name: 'read_file', description: 'Read a file' }] },
    }));

    const tools = await listPromise;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('read_file');

    await client.close();
  });

  it('callTool 正确映射 text content', async () => {
    const { transport, push, outbox } = makeControllableTransport();
    const client = createMcpClient({ serverName: 'test', transport });

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'initialize')!);
    push(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: {} }));
    await connectPromise;

    const callPromise = client.callTool('read_file', { path: '/tmp/a.txt' });
    await new Promise((r) => setTimeout(r, 10));
    const callReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'tools/call')!);
    push(JSON.stringify({
      jsonrpc: '2.0', id: callReq.id,
      result: {
        content: [{ type: 'text', text: 'hello world' }],
        isError: false,
      },
    }));

    const result = await callPromise;
    expect(result.text).toBe('hello world');
    expect(result.isError).toBe(false);

    await client.close();
  });

  it('callTool image/resource content 用占位符', async () => {
    const { transport, push, outbox } = makeControllableTransport();
    const client = createMcpClient({ serverName: 'test', transport });

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'initialize')!);
    push(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: {} }));
    await connectPromise;

    const callPromise = client.callTool('snapshot', {});
    await new Promise((r) => setTimeout(r, 10));
    const callReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'tools/call')!);
    push(JSON.stringify({
      jsonrpc: '2.0', id: callReq.id,
      result: {
        content: [
          { type: 'image', data: 'base64...' },
          { type: 'resource', uri: 'file://x' },
          { type: 'text', text: 'done' },
        ],
        isError: false,
      },
    }));

    const result = await callPromise;
    expect(result.text).toContain('[image]');
    expect(result.text).toContain('[resource]');
    expect(result.text).toContain('done');

    await client.close();
  });

  it('callTool 超时后返回超时错误', async () => {
    const { transport, push, outbox } = makeControllableTransport();
    const client = createMcpClient({ serverName: 'test', transport });

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'initialize')!);
    push(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: {} }));
    await connectPromise;

    await expect(client.callTool('slow_tool', {}, undefined, 50)).rejects.toThrow('timed out');

    await client.close();
  });

  it('transport 关闭后 pending 请求以错误返回，不永久挂起', async () => {
    const { transport, push, outbox, closeFn } = makeControllableTransport();
    const client = createMcpClient({ serverName: 'test', transport });

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(outbox.find((m) => JSON.parse(m).method === 'initialize')!);
    push(JSON.stringify({ jsonrpc: '2.0', id: initReq.id, result: {} }));
    await connectPromise;

    // 发起一个调用但不回包，然后关闭 transport
    const callPromise = client.callTool('hang', {});
    await new Promise((r) => setTimeout(r, 10));
    closeFn(); // 模拟 transport 意外关闭

    await expect(callPromise).rejects.toThrow();
  });
});
