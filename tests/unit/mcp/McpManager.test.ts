import { describe, it, expect, vi } from 'vitest';
import { initMcpManager } from '../../../src/mcp/McpManager.js';
import type { McpServerEntry, McpServersConfig } from '../../../src/config/mcpSchema.js';
import type { McpTransport } from '../../../src/mcp/transport/types.js';
import type { McpClient } from '../../../src/mcp/types.js';

// Mock createMcpClient
vi.mock('../../../src/mcp/McpClient.js', () => ({
  createMcpClient: vi.fn(),
}));

import { createMcpClient } from '../../../src/mcp/McpClient.js';

function makeSuccessClient(tools: Array<{ name: string; description?: string }>): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ text: 'ok', isError: false }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFailClient(error: Error): McpClient {
  return {
    connect: vi.fn().mockRejectedValue(error),
    listTools: vi.fn(),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTransport(): McpTransport {
  return {
    send: vi.fn(),
    messages: async function* () {},
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const configs: McpServersConfig = {
  server_a: { type: 'stdio', command: 'cmd_a', args: [], env: {} },
  server_b: { type: 'http', url: 'http://localhost:3000', headers: {} },
};

describe('McpManager', () => {
  it('连接成功时工具列表可通过 getTools 获取', async () => {
    vi.mocked(createMcpClient)
      .mockReturnValueOnce(makeSuccessClient([{ name: 'get_data', description: 'Get data' }]))
      .mockReturnValueOnce(makeSuccessClient([{ name: 'list_items', description: 'List items' }]));

    const { manager, initResults } = await initMcpManager(
      configs,
      () => makeTransport(),
    );

    expect(initResults.every((r) => r.status === 'connected')).toBe(true);
    const tools = manager.getTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('server_a__get_data');
    expect(names).toContain('server_b__list_items');
  });

  it('单个 Server 失败不影响其他 Server（N1 失败隔离）', async () => {
    vi.mocked(createMcpClient)
      .mockReturnValueOnce(makeFailClient(new Error('Connection refused')))
      .mockReturnValueOnce(makeSuccessClient([{ name: 'tool_b', description: 'Tool B' }]));

    const { manager, initResults } = await initMcpManager(
      configs,
      () => makeTransport(),
    );

    const failedResult = initResults.find((r) => r.serverName === 'server_a');
    const successResult = initResults.find((r) => r.serverName === 'server_b');

    expect(failedResult?.status).toBe('failed');
    expect(failedResult?.warning).toContain('Connection refused');
    expect(successResult?.status).toBe('connected');

    const tools = manager.getTools();
    expect(tools.map((t) => t.name)).toContain('server_b__tool_b');
    expect(tools.map((t) => t.name)).not.toContain('server_a__');
  });

  it('所有 Server 失败时 getTools 返回空数组', async () => {
    vi.mocked(createMcpClient).mockReturnValue(makeFailClient(new Error('fail')));

    const { manager } = await initMcpManager(configs, () => makeTransport());
    expect(manager.getTools()).toHaveLength(0);
  });

  it('searchTools 按关键词返回匹配工具（大小写不敏感）', async () => {
    vi.mocked(createMcpClient).mockReturnValue(
      makeSuccessClient([
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write to a file' },
        { name: 'list_repos', description: 'List GitHub repositories' },
      ]),
    );

    const singleConfig: McpServersConfig = {
      s: { type: 'stdio', command: 'cmd', args: [], env: {} },
    };
    const { manager } = await initMcpManager(singleConfig, () => makeTransport());

    const results = manager.searchTools('file');
    const names = results.map((t) => t.name);
    expect(names).toContain('s__read_file');
    expect(names).toContain('s__write_file');
    expect(names).not.toContain('s__list_repos');
  });

  it('searchTools 无匹配时返回空数组', async () => {
    vi.mocked(createMcpClient).mockReturnValue(
      makeSuccessClient([{ name: 'tool', description: 'A tool' }]),
    );
    const singleConfig: McpServersConfig = {
      s: { type: 'stdio', command: 'cmd', args: [], env: {} },
    };
    const { manager } = await initMcpManager(singleConfig, () => makeTransport());
    expect(manager.searchTools('zzznomatch')).toHaveLength(0);
  });

  it('closeAll 并发关闭所有 client', async () => {
    const client1 = makeSuccessClient([]);
    const client2 = makeSuccessClient([]);
    vi.mocked(createMcpClient)
      .mockReturnValueOnce(client1)
      .mockReturnValueOnce(client2);

    const { manager } = await initMcpManager(configs, () => makeTransport());
    await manager.closeAll();

    expect(client1.close).toHaveBeenCalled();
    expect(client2.close).toHaveBeenCalled();
  });
});
