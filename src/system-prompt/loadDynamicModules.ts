import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SystemPromptModule } from './types.js';
import { defaultRegistry } from './registry.js';

const CONFIG_DIRECTORY = '.agentcode';
const INSTRUCTIONS_FILE = 'instructions.md';
const MEMORY_FILE = 'memory.md';

/** 最大加载文件大小（4KB），避免过大文件消耗 token */
const MAX_FILE_SIZE_BYTES = 4096;

/**
 * 加载动态上下文模块（custom-instructions + memory），
 * 与 defaultRegistry 合并后返回完整注册表。
 *
 * 文件不存在或读取失败时静默跳过，不影响启动。
 */
export async function loadDynamicModules(cwd: string): Promise<SystemPromptModule[]> {
  const [instructions, memory] = await Promise.all([
    loadFileContent(join(cwd, CONFIG_DIRECTORY, INSTRUCTIONS_FILE)),
    loadFileContent(join(cwd, CONFIG_DIRECTORY, MEMORY_FILE)),
  ]);

  // 基于 defaultRegistry 浅拷贝，替换动态模块内容
  return defaultRegistry.map((mod) => {
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
 * 超过 MAX_FILE_SIZE_BYTES 时截断并附加提示。
 */
async function loadFileContent(path: string): Promise<string> {
  try {
    const buffer = await readFile(path);
    if (buffer.length === 0) {
      return '';
    }
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      return buffer.subarray(0, MAX_FILE_SIZE_BYTES).toString('utf8') + '\n...(truncated)';
    }
    return buffer.toString('utf8').trim();
  } catch {
    return '';
  }
}
