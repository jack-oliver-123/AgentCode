import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SystemPromptModule } from './types.js';
import { defaultRegistry } from './registry.js';

const CONFIG_DIRECTORY = '.agentcode';
const INSTRUCTIONS_FILE = 'instructions.md';
const MEMORY_FILE = 'memory.md';
const PROJECT_CONTEXT_FILE = 'CLAUDE.md';

/** .agentcode 下文件最大加载大小（4KB），避免过大文件消耗 token */
const MAX_FILE_SIZE_BYTES = 4096;
/** 项目根 CLAUDE.md 最大加载大小（16KB），项目级上下文通常更长 */
const MAX_PROJECT_CONTEXT_BYTES = 16 * 1024;

/**
 * 加载动态上下文模块（project-context + custom-instructions + memory），
 * 与 defaultRegistry 合并后返回完整注册表。
 *
 * 文件不存在或读取失败时静默跳过，不影响启动。
 */
export async function loadDynamicModules(cwd: string): Promise<SystemPromptModule[]> {
  const [projectContext, instructions, memory] = await Promise.all([
    loadFileContent(join(cwd, PROJECT_CONTEXT_FILE), MAX_PROJECT_CONTEXT_BYTES),
    loadFileContent(join(cwd, CONFIG_DIRECTORY, INSTRUCTIONS_FILE), MAX_FILE_SIZE_BYTES),
    loadFileContent(join(cwd, CONFIG_DIRECTORY, MEMORY_FILE), MAX_FILE_SIZE_BYTES),
  ]);

  // 基于 defaultRegistry 浅拷贝，替换动态模块内容
  return defaultRegistry.map((mod) => {
    if (mod.id === 'project-context' && projectContext.length > 0) {
      return { ...mod, content: `项目上下文（CLAUDE.md）：\n${projectContext}` };
    }
    if (mod.id === 'custom-instructions' && instructions.length > 0) {
      return { ...mod, content: `用户自定义指令：\n${instructions}` };
    }
    if (mod.id === 'memory' && memory.length > 0) {
      return { ...mod, content: `持久化记忆：\n${memory}` };
    }
    return mod;
  });
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
      return truncated + '\n...(truncated)';
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
  while (end > 0 && (buffer[end]! & 0xC0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString('utf8');
}
