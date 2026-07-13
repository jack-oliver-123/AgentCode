import type { CompiledRule, PermissionCheckInput, PermissionDecision, PermissionRuleConfig } from './types.js';
import { compileRule } from './ruleParser.js';
import type { PermissionRule } from './types.js';

/**
 * 将原始 YAML 规则数组编译为 CompiledRule 数组。
 */
export function compileRules(raw: readonly PermissionRule[]): CompiledRule[] {
  return raw.map(compileRule);
}

/**
 * 按工具名从 parsedArguments 中提取匹配目标字符串。
 */
export function extractMatchTarget(input: PermissionCheckInput): string | undefined {
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
 * 检查单条规则是否匹配输入。
 */
function ruleMatches(rule: CompiledRule, input: PermissionCheckInput): boolean {
  if (rule.toolName !== input.toolName) {
    return false;
  }

  // 无 pattern = 匹配该工具的所有调用
  if (rule.matcher === undefined) {
    return true;
  }

  const target = extractMatchTarget(input);
  return target !== undefined && rule.matcher(target);
}

/**
 * 在单层规则中查找第一条匹配的规则（first-match-wins）。
 */
function matchInLayer(
  rules: readonly CompiledRule[],
  input: PermissionCheckInput,
): CompiledRule | undefined {
  for (const rule of rules) {
    if (ruleMatches(rule, input)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * 规则引擎：按三层优先级（session → project → global）匹配规则。
 * 命中返回对应 allow/deny 判定，全未命中返回 undefined。
 */
export function matchRules(
  input: PermissionCheckInput,
  config: PermissionRuleConfig,
): PermissionDecision | undefined {
  // 按优先级检查：session → project → global
  const layers: readonly (readonly CompiledRule[])[] = [config.session, config.project, config.global];

  for (const layer of layers) {
    const matched = matchInLayer(layer, input);
    if (matched !== undefined) {
      if (matched.action === 'allow') {
        return { allowed: true, source: 'rule_allow' };
      }
      return {
        allowed: false,
        error: {
          code: 'permission_denied',
          message: `Denied by rule: ${matched.toolName}(${matched.argPattern ?? '*'})`,
          retryable: false,
        },
        source: 'rule_deny',
      };
    }
  }

  return undefined;
}
