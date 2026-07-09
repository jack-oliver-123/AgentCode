import picomatch from 'picomatch';

import type { CompiledRule, PermissionCheckInput } from './types.js';

export interface SessionAllowlist {
  has(input: PermissionCheckInput): boolean;
  add(rule: CompiledRule): void;
  clear(): void;
}

/**
 * 提取匹配目标（与 ruleEngine 逻辑一致）。
 */
function extractMatchTarget(input: PermissionCheckInput): string | undefined {
  const args = input.parsedArguments as Record<string, unknown> | null;
  if (args === null || typeof args !== 'object') {
    return undefined;
  }

  switch (input.toolName) {
    case 'run_command':
      return typeof args.command === 'string' ? args.command : undefined;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'search_code':
      return typeof args.path === 'string' ? args.path : undefined;
    case 'glob_files':
      return typeof args.pattern === 'string' ? args.pattern : undefined;
    default:
      return undefined;
  }
}

/**
 * 创建会话级规则存储。新增规则插入头部（优先级高于旧规则）。
 */
export function createSessionAllowlist(): SessionAllowlist {
  const rules: CompiledRule[] = [];

  return {
    has(input: PermissionCheckInput): boolean {
      for (const rule of rules) {
        if (rule.toolName !== input.toolName) {
          continue;
        }

        // 无 pattern = 匹配该工具所有调用
        if (rule.argPattern === undefined) {
          return rule.action === 'allow';
        }

        const target = extractMatchTarget(input);
        if (target === undefined) {
          continue;
        }

        const isMatch = picomatch(rule.argPattern, { dot: true });
        if (isMatch(target)) {
          return rule.action === 'allow';
        }
      }
      return false;
    },

    add(rule: CompiledRule): void {
      // 新增规则插入头部，优先级高于旧规则
      rules.unshift(rule);
    },

    clear(): void {
      rules.length = 0;
    },
  };
}
