import { join, resolve } from 'node:path';

import { readSafeFile } from '../shared/safeFs.js';

const CONFIG_DIRECTORY = '.agentcode';
const MEMORY_DIRECTORY = 'memory';
const INDEX_FILE = 'MEMORY.md';
const MAX_INDEX_BYTES = 25 * 1024;

export interface MemoryIndexes {
  user: string;
  project: string;
}

/** 分别读取用户级和项目级 MEMORY.md，供需要保留 level 归属的调用方使用。 */
export async function loadMemoryIndexes(cwd: string, homeDir: string): Promise<MemoryIndexes> {
  const [user, project] = await Promise.all([
    readIndex(resolve(homeDir), join(resolve(homeDir), CONFIG_DIRECTORY, MEMORY_DIRECTORY, INDEX_FILE)),
    readIndex(resolve(cwd), join(resolve(cwd), CONFIG_DIRECTORY, MEMORY_DIRECTORY, INDEX_FILE)),
  ]);
  return { user, project };
}

/** 按用户级在前、项目级在后的顺序合并两级记忆索引。 */
export async function loadMemoryIndex(cwd: string, homeDir: string): Promise<string> {
  const indexes = await loadMemoryIndexes(cwd, homeDir);
  const sections = [
    indexes.user.length > 0 ? `用户级记忆索引：\n${indexes.user}` : '',
    indexes.project.length > 0 ? `项目级记忆索引：\n${indexes.project}` : '',
  ];
  return sections.filter((section) => section.length > 0).join('\n\n');
}

async function readIndex(root: string, filePath: string): Promise<string> {
  try {
    const result = await readSafeFile(root, filePath, MAX_INDEX_BYTES);
    if (result === undefined) return '';
    const content = truncateAtUtf8Boundary(result.buffer).trim();
    return result.truncated ? `${content}\n...(truncated)` : content;
  } catch {
    return '';
  }
}

function truncateAtUtf8Boundary(buffer: Buffer): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = buffer.length; end >= Math.max(0, buffer.length - 4); end--) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // 最多回退一个 UTF-8 编码单元。
    }
  }
  return '';
}
