import { z } from 'zod';

// --- 原始配置类型（YAML snake_case） ---

const rawStdioServerSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1, 'mcp_servers stdio command is required'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string().min(1), z.string()).default({}),
});

const rawHttpServerSchema = z.object({
  type: z.literal('http'),
  url: z
    .string()
    .url('mcp_servers http url must be a valid URL')
    .refine(
      (url) => url.startsWith('http://') || url.startsWith('https://'),
      'mcp_servers http url must use http or https',
    ),
  headers: z.record(z.string().min(1), z.string()).default({}),
});

const rawMcpServerEntrySchema = z.discriminatedUnion('type', [
  rawStdioServerSchema,
  rawHttpServerSchema,
]);

export const rawMcpServersConfigSchema = z.record(z.string().min(1), rawMcpServerEntrySchema);

// --- 运行时类型（camelCase，展开后） ---

export type McpServerEntry =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

export type McpServersConfig = Record<string, McpServerEntry>;

// --- ${VAR} 展开 ---

/**
 * 单次线性展开 value 中的 ${VAR} 语法。
 *
 * - 仅对值字段调用，不对 key 字段调用（N3 安全约束）
 * - 单次替换，不循环（防止 process.env.A="${B}" 导致二次展开）
 * - 引用不存在的变量时展开为空字符串，不报错（N3）
 */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}

function expandEnvRecord(record: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    result[k] = expandEnvVars(v);
  }
  return result;
}

// --- 解析与归一化 ---

/**
 * 解析原始 mcp_servers 配置，对所有 env/headers 值做 ${VAR} 展开。
 * 传入 undefined 时返回空对象。
 */
export function parseMcpServersConfig(raw: unknown): McpServersConfig {
  if (raw === undefined || raw === null) return {};

  const parsed = rawMcpServersConfigSchema.parse(raw);
  const result: McpServersConfig = {};

  for (const [serverName, entry] of Object.entries(parsed)) {
    if (entry.type === 'stdio') {
      result[serverName] = {
        type: 'stdio',
        command: entry.command,
        args: entry.args,
        env: expandEnvRecord(entry.env),
      };
    } else {
      result[serverName] = {
        type: 'http',
        url: entry.url,
        headers: expandEnvRecord(entry.headers),
      };
    }
  }

  return result;
}

/**
 * 双层 key 级合并：project 条目覆盖同名 global 条目，不同名的各自保留。
 * 与主配置"互斥选一"语义独立，是 MCP 专属的合并语义（F2/N6）。
 */
export function mergeMcpConfigs(
  global?: McpServersConfig,
  project?: McpServersConfig,
): McpServersConfig {
  return {
    ...(global ?? {}),
    ...(project ?? {}),
  };
}
