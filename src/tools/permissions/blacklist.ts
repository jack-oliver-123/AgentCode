import type { PermissionCheckInput, PermissionDecision } from './types.js';
import { BLACKLIST_PATTERNS } from './blacklistPatterns.js';

/**
 * 黑名单层：检查 run_command 工具的 command 参数是否匹配危险命令正则。
 * 命中返回 deny，未命中或非 run_command 工具返回 undefined（交给下一层）。
 */
export function checkBlacklist(input: PermissionCheckInput): PermissionDecision | undefined {
  if (input.toolName !== 'run_command') {
    return undefined;
  }

  const args = input.parsedArguments as Record<string, unknown> | null;
  const command = typeof args?.command === 'string' ? args.command : '';

  if (command.length === 0) {
    return undefined;
  }

  for (const pattern of BLACKLIST_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        error: {
          code: 'permission_denied',
          message: `Command blocked by blacklist: matches dangerous pattern.`,
          retryable: false,
        },
        source: 'blacklist',
      };
    }
  }

  return undefined;
}
