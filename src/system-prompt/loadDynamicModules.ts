import { access, readFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import { defaultRegistry } from './registry.js';
import type { SystemPromptModule } from './types.js';

const CONFIG_DIRECTORY = '.agentcode';

/**
 * 动态模块源定义表。每个条目声明：
 * - id：对应 registry 中的模块 id
 * - label：注入 system prompt 时的前缀标签
 * - maxBytes：文件体积上限（不含前缀标签长度）
 * - resolvePath：根据 cwd 解析文件路径的策略
 */
const DYNAMIC_SOURCES = [
  {
    id: 'project-context',
    label: '项目上下文（CLAUDE.md）',
    maxBytes: 16 * 1024,
    resolvePath: (cwd: string) => findFileUpwards(cwd, 'CLAUDE.md'),
  },
  {
    id: 'custom-instructions',
    label: '用户自定义指令',
    maxBytes: 4096,
    resolvePath: (cwd: string) => Promise.resolve(join(cwd, CONFIG_DIRECTORY, 'instructions.md')),
  },
  {
    id: 'memory',
    label: '持久化记忆',
    maxBytes: 4096,
    resolvePath: (cwd: string) => Promise.resolve(join(cwd, CONFIG_DIRECTORY, 'memory.md')),
  },
] as const;

/**
 * 加载动态上下文模块（project-context + custom-instructions + memory），
 * 与 defaultRegistry 合并后返回完整注册表。
 *
 * - CLAUDE.md 从 cwd 向上遍历到文件系统根目录查找（与 loadConfig 行为一致）
 * - .agentcode/ 下的文件仅在 cwd 下查找
 * - 文件不存在或读取失败时静默跳过，不影响启动
 */
export async function loadDynamicModules(cwd: string): Promise<SystemPromptModule[]> {
  // 并行解析路径并加载内容
  const loaded = await Promise.all(
    DYNAMIC_SOURCES.map(async (source) => {
      const filePath = await source.resolvePath(cwd);
      if (filePath === undefined) return { id: source.id, content: '' };
      const content = await loadFileContent(filePath, source.maxBytes);
      return { id: source.id, content };
    }),
  );

  // 建立 id → content 的映射
  const contentMap = new Map<string, string>(loaded.map((item) => [item.id, item.content]));
  const labelMap = new Map<string, string>(DYNAMIC_SOURCES.map((s) => [s.id, s.label]));

  // 基于 defaultRegistry 浅拷贝，替换动态模块内容
  return defaultRegistry.map((mod) => {
    const content = contentMap.get(mod.id);
    const label = labelMap.get(mod.id);
    if (content !== undefined && content.length > 0 && label !== undefined) {
      return { ...mod, content: `${label}：\n${content}` };
    }
    return mod;
  });
}

/**
 * 从 startDir 向上遍历目录查找指定文件名，找到则返回完整路径，
 * 到达文件系统根目录仍未找到时返回 undefined。
 */
async function findFileUpwards(startDir: string, fileName: string): Promise<string | undefined> {
  let current = resolve(startDir);
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, fileName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 文件不存在，继续向上
    }

    if (current === root) {
      return undefined;
    }
    current = dirname(current);
  }
}

/**
 * 安全读取文件内容，不存在或失败时返回空字符串。
 * 超过 maxBytes 时截断到 UTF-8 安全边界并附加提示。
 */
async function loadFileContent(path: string, maxBytes: number): Promise<string> {
  try {
    const buffer = await readFile(path);
    if (buffer.length === 0) {
      return '';
    }
    if (buffer.length > maxBytes) {
      const truncated = truncateAtUtf8Boundary(buffer, maxBytes);
      return `${truncated.trim()}\n...(truncated)`;
    }
    return buffer.toString('utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 在字节限制处回退到合法 UTF-8 字符边界，避免劈裂多字节字符。
 * UTF-8 continuation bytes 以 0b10xxxxxx 开头（0x80-0xBF），
 * 向前回退直到找到非 continuation byte（即字符起始字节）。
 */
function truncateAtUtf8Boundary(buffer: Buffer, maxBytes: number): string {
  let end = maxBytes;
  // 回退最多 4 字节（UTF-8 最长编码单位）
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString('utf8');
}
