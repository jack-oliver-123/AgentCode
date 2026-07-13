import { describe, it, expect } from 'vitest';
import { expandEnvVars, parseMcpServersConfig, mergeMcpConfigs } from '../../../src/config/mcpSchema.js';

describe('expandEnvVars', () => {
  it('展开已存在的环境变量', () => {
    process.env['TEST_MCP_VAR'] = 'hello';
    const result = expandEnvVars('prefix-${TEST_MCP_VAR}-suffix');
    expect(result).toBe('prefix-hello-suffix');
    delete process.env['TEST_MCP_VAR'];
  });

  it('不存在的变量展开为空字符串', () => {
    const result = expandEnvVars('${NONEXISTENT_VAR_XYZ_123}');
    expect(result).toBe('');
  });

  it('单次展开（不循环替换）', () => {
    process.env['A_MCP_TEST'] = '${B_MCP_TEST}';
    process.env['B_MCP_TEST'] = 'should-not-appear';
    const result = expandEnvVars('${A_MCP_TEST}');
    // 单次替换结果为字面量 ${B_MCP_TEST}，不继续展开
    expect(result).toBe('${B_MCP_TEST}');
    delete process.env['A_MCP_TEST'];
    delete process.env['B_MCP_TEST'];
  });

  it('不含 ${} 的字符串原样返回', () => {
    expect(expandEnvVars('plain-string')).toBe('plain-string');
  });

  it('多个变量引用各自展开', () => {
    process.env['VAR_X'] = 'x';
    process.env['VAR_Y'] = 'y';
    const result = expandEnvVars('${VAR_X}-${VAR_Y}');
    expect(result).toBe('x-y');
    delete process.env['VAR_X'];
    delete process.env['VAR_Y'];
  });
});

describe('parseMcpServersConfig', () => {
  it('解析 stdio 类型', () => {
    const config = parseMcpServersConfig({
      my_server: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'my-mcp'],
        env: { PORT: '3000' },
      },
    });
    expect(config['my_server']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'my-mcp'],
      env: { PORT: '3000' },
    });
  });

  it('解析 http 类型', () => {
    const config = parseMcpServersConfig({
      remote: {
        type: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
    });
    expect(config['remote']).toEqual({
      type: 'http',
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('env/headers 值做 ${VAR} 展开', () => {
    process.env['MY_API_KEY'] = 'real-key';
    const config = parseMcpServersConfig({
      s: { type: 'stdio', command: 'cmd', args: [], env: { API_KEY: '${MY_API_KEY}' } },
    });
    expect((config['s'] as { env: Record<string, string> }).env['API_KEY']).toBe('real-key');
    delete process.env['MY_API_KEY'];
  });

  it('传入 undefined 返回空对象', () => {
    expect(parseMcpServersConfig(undefined)).toEqual({});
  });

  it('传入 null 返回空对象', () => {
    expect(parseMcpServersConfig(null)).toEqual({});
  });

  it('stdio 缺少 command 时抛出 ZodError', () => {
    expect(() =>
      parseMcpServersConfig({ s: { type: 'stdio', args: [] } }),
    ).toThrow();
  });
});

describe('mergeMcpConfigs', () => {
  it('project 覆盖同名 global 条目', () => {
    const global = {
      serverA: { type: 'stdio' as const, command: 'cmd-global', args: [], env: {} },
      serverB: { type: 'http' as const, url: 'http://global.com', headers: {} },
    };
    const project = {
      serverB: { type: 'http' as const, url: 'http://project.com', headers: {} },
      serverC: { type: 'stdio' as const, command: 'cmd-c', args: [], env: {} },
    };
    const merged = mergeMcpConfigs(global, project);

    expect(merged['serverA']).toEqual(global['serverA']);
    expect((merged['serverB'] as { url: string }).url).toBe('http://project.com');
    expect(merged['serverC']).toEqual(project['serverC']);
    expect(Object.keys(merged)).toHaveLength(3);
  });

  it('只有 global 时返回 global', () => {
    const global = {
      s: { type: 'stdio' as const, command: 'cmd', args: [], env: {} },
    };
    expect(mergeMcpConfigs(global, undefined)).toEqual(global);
  });

  it('只有 project 时返回 project', () => {
    const project = {
      s: { type: 'http' as const, url: 'http://x.com', headers: {} },
    };
    expect(mergeMcpConfigs(undefined, project)).toEqual(project);
  });

  it('两者都为空时返回空对象', () => {
    expect(mergeMcpConfigs(undefined, undefined)).toEqual({});
  });
});
