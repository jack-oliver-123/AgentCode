import type {
  ToolDefinition,
  ToolErrorCode,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolJsonSchema,
  ToolRisk,
  ToolValidationResult,
} from '../tools/types.js';
import type { McpCallResult, McpRawTool } from './types.js';

// --- Risk 推断关键词 ---

const EXECUTE_KEYWORDS = ['execute', 'run', 'invoke', 'call', '执行', '运行'];
const WRITE_KEYWORDS = [
  'write', 'create', 'update', 'delete', 'modify', 'remove', 'set',
  '写入', '创建', '更新', '删除', '修改',
];
const READ_KEYWORDS = [
  'read', 'get', 'list', 'search', 'query', 'fetch',
  '读取', '查询', '列出', '搜索', '获取',
];

/**
 * 根据工具名称和描述推断 risk 级别（大小写不敏感）。
 * 优先级：execute（保守兜底）> write > read；无法判断时返回 execute。
 */
export function inferRisk(name: string, description: string): ToolRisk {
  const text = `${name} ${description}`.toLowerCase();

  if (EXECUTE_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))) {
    return 'execute';
  }
  if (WRITE_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))) {
    return 'write';
  }
  if (READ_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))) {
    return 'read';
  }

  // 无法判断时保守兜底为 execute
  return 'execute';
}

// --- Schema 归一化 ---

/**
 * 将 MCP 返回的原始 inputSchema 归一化为 ToolJsonSchema。
 * 复杂类型（object/array）降级为 string + description 注明传 JSON 字符串，
 * 与 submitPlan.ts 模式一致，防止代理网关 schema bug（Issue #11）。
 */
export function normalizeMcpSchema(rawSchema: unknown): ToolJsonSchema {
  const empty: ToolJsonSchema = { type: 'object', properties: {}, additionalProperties: false };

  if (typeof rawSchema !== 'object' || rawSchema === null) return empty;

  const schema = rawSchema as Record<string, unknown>;
  const rawProps = schema['properties'];
  if (typeof rawProps !== 'object' || rawProps === null) return empty;

  const props = rawProps as Record<string, unknown>;
  const normalized: ToolJsonSchema['properties'] = {};

  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'object' || value === null) {
      normalized[key] = { type: 'string', description: key };
      continue;
    }
    const prop = value as Record<string, unknown>;
    const type = prop['type'];
    const desc = typeof prop['description'] === 'string' ? prop['description'] : key;

    if (type === 'string') {
      normalized[key] = { type: 'string', description: desc };
    } else if (type === 'number') {
      normalized[key] = { type: 'number', description: desc };
    } else if (type === 'boolean') {
      normalized[key] = { type: 'boolean', description: desc };
    } else {
      // object/array 及其他复杂类型降级为 string + JSON 说明
      normalized[key] = {
        type: 'string',
        description: `${desc} (传入 JSON 字符串)`,
      };
    }
  }

  const required = Array.isArray(schema['required'])
    ? (schema['required'] as string[])
    : undefined;

  return {
    type: 'object',
    properties: normalized,
    additionalProperties: false,
    ...(required !== undefined && required.length > 0 ? { required } : {}),
  };
}

// --- 工具适配 ---

type CallFn = (
  name: string,
  args: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<McpCallResult>;

/**
 * 将 MCP 原始工具包装为 AgentCode ToolDefinition。
 *
 * - 命名：`{serverName}__{toolName}`（双下划线，N4 命名空间隔离）
 * - risk：inferRisk 自动推断
 * - schema：normalizeMcpSchema 归一化（复杂类型降级）
 * - execute：透传给 callFn，结果映射为 ToolExecutionResult
 */
export function adaptMcpTool(
  serverName: string,
  raw: McpRawTool,
  callFn: CallFn,
): ToolDefinition {
  const toolName = `${serverName}__${raw.name}`;
  const description = raw.description ?? `MCP tool: ${raw.name}`;
  const risk = inferRisk(raw.name, description);
  const inputSchema = normalizeMcpSchema(raw.inputSchema);

  return {
    name: toolName,
    description,
    inputSchema,
    risk,

    validate(input: unknown): ToolValidationResult<unknown> {
      if (typeof input !== 'object' || input === null) {
        return {
          ok: false,
          error: {
            code: 'invalid_arguments',
            message: `${toolName}: arguments must be an object`,
            retryable: false,
          },
        };
      }
      return { ok: true, value: input };
    },

    async execute(
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult<unknown>> {
      const start = Date.now();
      try {
        const result = await callFn(raw.name, input, context.signal, context.timeoutMs);
        const durationMs = Date.now() - start;

        if (result.isError) {
          return {
            ok: false,
            toolName,
            error: {
              code: 'tool_internal_error' as ToolErrorCode,
              message: result.text || `MCP tool ${raw.name} returned an error`,
              retryable: false,
            },
            meta: { durationMs, timedOut: false },
          };
        }

        return {
          ok: true,
          toolName,
          data: result.text,
          meta: { durationMs, timedOut: false },
        };
      } catch (err) {
        const durationMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = message.includes('timed out');

        return {
          ok: false,
          toolName,
          error: {
            code: timedOut ? ('command_timeout' as ToolErrorCode) : ('tool_internal_error' as ToolErrorCode),
            message,
            retryable: false,
          },
          meta: { durationMs, timedOut },
        };
      }
    },
  };
}
