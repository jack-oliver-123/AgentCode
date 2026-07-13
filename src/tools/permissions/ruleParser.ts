import picomatch from 'picomatch';

import type { CompiledRule, PermissionRule } from './types.js';

/**
 * 解析规则字符串 "tool_name(glob_pattern)" 为结构化格式。
 * 无括号时 argPattern 为 undefined（匹配所有参数）。
 */
export function parseRulePattern(rule: string): { toolName: string; argPattern: string | undefined } {
  const match = rule.match(/^([a-z_]+)(?:\((.+)\))?$/);
  if (match === null) {
    return { toolName: rule, argPattern: undefined };
  }

  const toolName = match[1] as string;
  const argPattern = match[2]; // undefined if no parentheses
  return { toolName, argPattern };
}

/**
 * 将原始 YAML 规则编译为结构化格式。
 */
export function compileRule(raw: PermissionRule): CompiledRule {
  const { toolName, argPattern } = parseRulePattern(raw.rule);
  const matcher = argPattern === undefined ? undefined : picomatch(argPattern, { dot: true });
  return { toolName, argPattern, matcher, action: raw.action };
}
