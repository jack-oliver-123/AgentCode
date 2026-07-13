import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// readline mock
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
  })),
}));

import { createStdioTransport } from '../../../../src/mcp/transport/StdioTransport.js';

describe('StdioTransport - env 白名单（F9）', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  it('spawn 时 env 只含 PATH 和配置 env，不含宿主其他变量', () => {
    // 设置宿主 process.env
    const originalEnv = process.env;
    process.env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret-key',
      HOME: '/home/user',
      MY_TOKEN: 'super-secret',
    };

    const mockStdin = { write: vi.fn() };
    const mockStdout = null;
    const mockStderr = { resume: vi.fn() };
    const mockProcess = {
      stdin: mockStdin,
      stdout: mockStdout,
      stderr: mockStderr,
      kill: vi.fn(),
      env: {},
    };
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    createStdioTransport({
      command: 'my-mcp-server',
      args: ['--port', '3000'],
      env: { MCP_API_KEY: 'mcp-key', MCP_BASE_URL: 'http://localhost' },
    });

    expect(spawn).toHaveBeenCalledOnce();
    const spawnCall = vi.mocked(spawn).mock.calls[0]!;
    const spawnOptions = spawnCall[2] as { env: Record<string, string> };
    const childEnv = spawnOptions.env;

    // 只含 PATH 和配置中显式声明的 env
    expect(childEnv['PATH']).toBe('/usr/bin');
    expect(childEnv['MCP_API_KEY']).toBe('mcp-key');
    expect(childEnv['MCP_BASE_URL']).toBe('http://localhost');

    // 不含宿主的敏感变量
    expect(childEnv['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(childEnv['HOME']).toBeUndefined();
    expect(childEnv['MY_TOKEN']).toBeUndefined();

    process.env = originalEnv;
  });

  it('命令和参数正确透传', () => {
    const mockProcess = {
      stdin: { write: vi.fn() },
      stdout: null,
      stderr: { resume: vi.fn() },
      kill: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    createStdioTransport({ command: 'npx', args: ['-y', '@mcp/server'], env: {} });

    const spawnCall = vi.mocked(spawn).mock.calls[0]!;
    expect(spawnCall[0]).toBe('npx');
    expect(spawnCall[1]).toEqual(['-y', '@mcp/server']);
  });

  it('stdio 配置为 pipe', () => {
    const mockProcess = {
      stdin: { write: vi.fn() },
      stdout: null,
      stderr: { resume: vi.fn() },
      kill: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    createStdioTransport({ command: 'server', args: [], env: {} });

    const spawnCall = vi.mocked(spawn).mock.calls[0]!;
    const options = spawnCall[2] as { stdio: unknown };
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });
});
