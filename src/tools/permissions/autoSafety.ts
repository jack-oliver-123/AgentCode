import picomatch from 'picomatch';

import type { PermissionCheckInput, PermissionDecision, PermissionMode } from './types.js';

/** auto 模式下写/编辑工具的安全路径白名单 */
const SAFE_WRITE_PATTERNS: readonly string[] = ['src/**', 'tests/**', 'docs/**'];

/** auto 模式下 run_command 安全命令前缀白名单 */
const SAFE_COMMAND_PREFIXES: readonly string[] = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'npm test',
  'npm run build',
  'npm run typecheck',
  'npx tsc --noEmit',
  'npx vitest',
];

/**
 * Auto 安全规则层：仅 auto 模式激活。
 * 判断已知安全操作自动放行，不确定的返回 undefined 交给后续层。
 */
export function checkAutoSafety(
  input: PermissionCheckInput,
  mode: PermissionMode,
): PermissionDecision | undefined {
  if (mode !== 'auto') {
    return undefined;
  }

  // read 工具全部自动放行
  if (input.toolRisk === 'read') {
    return { allowed: true, source: 'auto_safety' };
  }

  const args = input.parsedArguments as Record<string, unknown> | null;

  // write/edit 工具：路径匹配安全目录时放行
  if (input.toolName === 'write_file' || input.toolName === 'edit_file') {
    const path = typeof args?.path === 'string' ? args.path : '';
    if (path.length > 0 && matchesSafeWritePath(path)) {
      return { allowed: true, source: 'auto_safety' };
    }
    return undefined;
  }

  // run_command：前缀匹配安全命令白名单
  if (input.toolName === 'run_command') {
    const command = typeof args?.command === 'string' ? args.command : '';
    if (command.length > 0 && matchesSafeCommand(command)) {
      return { allowed: true, source: 'auto_safety' };
    }
    return undefined;
  }

  return undefined;
}

function matchesSafeWritePath(path: string): boolean {
  for (const pattern of SAFE_WRITE_PATTERNS) {
    const isMatch = picomatch(pattern, { dot: true });
    if (isMatch(path)) {
      return true;
    }
  }
  return false;
}

function matchesSafeCommand(command: string): boolean {
  for (const prefix of SAFE_COMMAND_PREFIXES) {
    if (command === prefix || command.startsWith(`${prefix} `)) {
      return true;
    }
  }
  return false;
}
