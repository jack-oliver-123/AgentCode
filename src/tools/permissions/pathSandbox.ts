import { resolveWorkspacePath } from '../workspace.js';
import type { PermissionCheckInput, PermissionDecision } from './types.js';

/** 文件类工具集合 */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'glob_files',
  'search_code',
]);

/** 按工具名提取路径参数的字段映射 */
function extractPath(input: PermissionCheckInput): string | undefined {
  if (!FILE_TOOLS.has(input.toolName)) {
    return undefined;
  }

  const args = input.parsedArguments as Record<string, unknown> | null;
  if (args === null || typeof args !== 'object') {
    return undefined;
  }

  if (input.toolName === 'glob_files') {
    return typeof args.pattern === 'string' ? args.pattern : undefined;
  }

  // read_file, write_file, edit_file, search_code 都用 path 字段
  return typeof args.path === 'string' ? args.path : undefined;
}

/**
 * 路径沙箱层：检查文件类工具的路径参数是否在工作区内。
 * 复用已有的 resolveWorkspacePath 实现。
 * 路径越界返回 deny，正常或非文件工具返回 undefined。
 */
export async function checkPathSandbox(
  input: PermissionCheckInput,
  cwd: string,
): Promise<PermissionDecision | undefined> {
  const path = extractPath(input);
  if (path === undefined) {
    return undefined;
  }

  const result = await resolveWorkspacePath(cwd, path);
  if (!result.ok) {
    return {
      allowed: false,
      error: {
        code: 'permission_denied',
        message: `Path sandbox: ${result.error.message}`,
        retryable: false,
      },
      source: 'path_sandbox',
    };
  }

  return undefined;
}
