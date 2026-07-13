import { describe, it, expect, vi } from 'vitest';
import { inferRisk, normalizeMcpSchema, adaptMcpTool } from '../../../src/mcp/McpToolAdapter.js';

describe('inferRisk', () => {
  it('read 关键词推断为 read', () => {
    expect(inferRisk('get_user', 'Fetch user details')).toBe('read');
    expect(inferRisk('list_files', '')).toBe('read');
    expect(inferRisk('search_code', '')).toBe('read');
    expect(inferRisk('query_db', '')).toBe('read');
    expect(inferRisk('tool', '读取文件内容')).toBe('read');
    expect(inferRisk('tool', '列出所有项目')).toBe('read');
    expect(inferRisk('tool', '查询数据')).toBe('read');
    expect(inferRisk('tool', '获取结果')).toBe('read');
  });

  it('write 关键词推断为 write', () => {
    expect(inferRisk('write_file', 'Write content to a file')).toBe('write');
    expect(inferRisk('create_issue', '')).toBe('write');
    expect(inferRisk('delete_record', '')).toBe('write');
    expect(inferRisk('update_config', '')).toBe('write');
    expect(inferRisk('tool', '写入数据库')).toBe('write');
    expect(inferRisk('tool', '删除文件')).toBe('write');
    expect(inferRisk('tool', '创建新项目')).toBe('write');
  });

  it('execute/run/invoke 推断为 execute（优先级最高）', () => {
    expect(inferRisk('run_script', '')).toBe('execute');
    expect(inferRisk('execute_command', '')).toBe('execute');
    expect(inferRisk('invoke_function', '')).toBe('execute');
    expect(inferRisk('tool', '执行命令')).toBe('execute');
    expect(inferRisk('tool', '运行脚本')).toBe('execute');
  });

  it('无法判断时兜底为 execute', () => {
    expect(inferRisk('do_something', 'Performs an action')).toBe('execute');
    expect(inferRisk('tool', '')).toBe('execute');
  });

  it('大小写不敏感', () => {
    expect(inferRisk('GET_user', '')).toBe('read');
    expect(inferRisk('DELETE_record', '')).toBe('write');
  });
});

describe('normalizeMcpSchema', () => {
  it('标量类型保持不变', () => {
    const schema = normalizeMcpSchema({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A name' },
        count: { type: 'number', description: 'A count' },
        flag: { type: 'boolean', description: 'A flag' },
      },
    });
    expect(schema.properties['name']).toEqual({ type: 'string', description: 'A name' });
    expect(schema.properties['count']).toEqual({ type: 'number', description: 'A count' });
    expect(schema.properties['flag']).toEqual({ type: 'boolean', description: 'A flag' });
  });

  it('object/array 类型降级为 string + JSON 说明', () => {
    const schema = normalizeMcpSchema({
      type: 'object',
      properties: {
        items: { type: 'array', description: 'List of items' },
        config: { type: 'object', description: 'Config object' },
      },
    });
    expect(schema.properties['items']!.type).toBe('string');
    expect((schema.properties['items'] as { description: string }).description).toContain('JSON');
    expect(schema.properties['config']!.type).toBe('string');
  });

  it('缺少 inputSchema 时返回空 schema', () => {
    const schema = normalizeMcpSchema(undefined);
    expect(schema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('required 字段正确透传', () => {
    const schema = normalizeMcpSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'Name' } },
      required: ['name'],
    });
    expect(schema.required).toEqual(['name']);
  });
});

describe('adaptMcpTool', () => {
  it('工具名格式为 serverName__toolName', () => {
    const tool = adaptMcpTool('myserver', { name: 'get_data', description: 'Get data' }, vi.fn());
    expect(tool.name).toBe('myserver__get_data');
  });

  it('risk 正确推断', () => {
    const readTool = adaptMcpTool('s', { name: 'get_info', description: 'Get info' }, vi.fn());
    expect(readTool.risk).toBe('read');

    const writeTool = adaptMcpTool('s', { name: 'write_file', description: '' }, vi.fn());
    expect(writeTool.risk).toBe('write');
  });

  it('validate 拒绝非对象参数', () => {
    const tool = adaptMcpTool('s', { name: 'tool', description: '' }, vi.fn());
    const result = tool.validate('not-an-object');
    expect(result.ok).toBe(false);
  });

  it('execute 调用 callFn 并返回成功结果', async () => {
    const callFn = vi.fn().mockResolvedValue({ text: 'hello', isError: false });
    const tool = adaptMcpTool('s', { name: 'greet', description: '' }, callFn);

    const context = {
      cwd: '/tmp',
      timeoutMs: 5000,
      secrets: [],
      maxOutputBytes: 1000,
    };
    const result = await tool.execute({ name: 'world' }, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('hello');
    expect(callFn).toHaveBeenCalledWith('greet', { name: 'world' }, undefined, 5000);
  });

  it('execute 当 isError=true 时返回失败结果', async () => {
    const callFn = vi.fn().mockResolvedValue({ text: 'Something went wrong', isError: true });
    const tool = adaptMcpTool('s', { name: 'fail_tool', description: '' }, callFn);
    const context = { cwd: '/tmp', timeoutMs: 5000, secrets: [], maxOutputBytes: 1000 };
    const result = await tool.execute({}, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('tool_internal_error');
  });
});
