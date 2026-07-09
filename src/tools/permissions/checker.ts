import type {
  AskPermissionFn,
  CompiledRule,
  PermissionCheckInput,
  PermissionChecker,
  PermissionDecision,
  PermissionMode,
  PermissionRuleConfig,
} from './types.js';

import { checkBlacklist } from './blacklist.js';
import { checkPathSandbox } from './pathSandbox.js';
import { matchRules } from './ruleEngine.js';
import { checkAutoSafety } from './autoSafety.js';
import { applyModeDefault } from './modePolicy.js';
import { createSessionAllowlist } from './sessionAllowlist.js';
import { buildPromptDescription } from './promptDescription.js';
import { appendProjectRule } from './config.js';
import { parseRulePattern } from './ruleParser.js';

export interface CreatePermissionCheckerOptions {
  mode: PermissionMode;
  ruleConfig: PermissionRuleConfig;
  cwd: string;
  askFn?: AskPermissionFn | undefined;
}

/**
 * 创建 PermissionChecker 实例。
 * 组装 5 层管道：blacklist → pathSandbox → ruleEngine → autoSafety → modePolicy。
 */
export function createPermissionChecker(options: CreatePermissionCheckerOptions): PermissionChecker {
  let currentMode = options.mode;
  const sessionAllowlist = createSessionAllowlist();

  // 可变规则配置（session 层由 allowlist 管理）
  const ruleConfig: PermissionRuleConfig = {
    session: options.ruleConfig.session,
    project: options.ruleConfig.project,
    global: options.ruleConfig.global,
  };

  async function check(input: PermissionCheckInput): Promise<PermissionDecision> {
    // Layer 1: 黑名单
    const blacklistResult = checkBlacklist(input);
    if (blacklistResult !== undefined) {
      return blacklistResult;
    }

    // Layer 2: 路径沙箱
    const pathResult = await checkPathSandbox(input, options.cwd);
    if (pathResult !== undefined) {
      return pathResult;
    }

    // Layer 3: 规则引擎
    const ruleResult = matchRules(input, ruleConfig);
    if (ruleResult !== undefined) {
      return ruleResult;
    }

    // Session allowlist 检查（类似规则但动态添加）
    if (sessionAllowlist.has(input)) {
      return { allowed: true, source: 'session_grant' };
    }

    // Layer 4: Auto 安全规则
    const autoResult = checkAutoSafety(input, currentMode);
    if (autoResult !== undefined) {
      return autoResult;
    }

    // Layer 5: 模式策略
    const modeResult = applyModeDefault(input, currentMode);
    if (modeResult !== 'needs_prompt') {
      return modeResult;
    }

    // 需要人工确认
    if (options.askFn === undefined) {
      // 无 askFn → fail-safe deny
      return {
        allowed: false,
        error: {
          code: 'permission_denied',
          message: 'Permission prompt required but no UI available.',
          retryable: false,
        },
        source: 'mode_default',
      };
    }

    const description = buildPromptDescription(input);
    let response;
    try {
      response = await options.askFn(input, description);
    } catch {
      // askFn 异常/超时 → deny
      return {
        allowed: false,
        error: {
          code: 'permission_denied',
          message: 'Permission prompt timed out or failed.',
          retryable: false,
        },
        source: 'user_prompt',
      };
    }

    switch (response.action) {
      case 'allow_once':
        return { allowed: true, source: 'user_prompt' };

      case 'allow_session': {
        // 将当前输入转为 session 规则
        const rule = buildRuleFromInput(input);
        sessionAllowlist.add(rule);
        return { allowed: true, source: 'session_grant' };
      }

      case 'allow_permanent': {
        const rule = buildRuleFromInput(input);
        sessionAllowlist.add(rule);
        try {
          const ruleStr = buildRuleString(input);
          appendProjectRule(options.cwd, ruleStr);
        } catch (err) {
          console.warn('[permission] 写入永久规则失败，降级为 session grant:', err);
        }
        return { allowed: true, source: 'session_grant' };
      }

      case 'deny':
        return {
          allowed: false,
          error: {
            code: 'permission_denied',
            message: 'User denied the operation.',
            retryable: false,
          },
          source: 'user_prompt',
        };
    }
  }

  function addSessionRule(rule: CompiledRule): void {
    sessionAllowlist.add(rule);
  }

  function getMode(): PermissionMode {
    return currentMode;
  }

  function setMode(mode: PermissionMode): void {
    currentMode = mode;
  }

  return { check, addSessionRule, getMode, setMode };
}

/**
 * 从输入构建 CompiledRule（用于 session/permanent 规则记录）。
 */
function buildRuleFromInput(input: PermissionCheckInput): CompiledRule {
  const args = input.parsedArguments as Record<string, unknown> | null;
  let argPattern: string | undefined;

  if (args !== null && typeof args === 'object') {
    switch (input.toolName) {
      case 'run_command':
        argPattern = typeof args.command === 'string' ? args.command : undefined;
        break;
      case 'read_file':
      case 'write_file':
      case 'edit_file':
      case 'search_code':
        argPattern = typeof args.path === 'string' ? args.path : undefined;
        break;
      case 'glob_files':
        argPattern = typeof args.pattern === 'string' ? args.pattern : undefined;
        break;
    }
  }

  return { toolName: input.toolName, argPattern, action: 'allow' };
}

/**
 * 从输入构建 rule 字符串（用于 YAML 持久化）。
 */
function buildRuleString(input: PermissionCheckInput): string {
  const args = input.parsedArguments as Record<string, unknown> | null;
  let argPattern: string | undefined;

  if (args !== null && typeof args === 'object') {
    switch (input.toolName) {
      case 'run_command':
        argPattern = typeof args.command === 'string' ? args.command : undefined;
        break;
      case 'read_file':
      case 'write_file':
      case 'edit_file':
      case 'search_code':
        argPattern = typeof args.path === 'string' ? args.path : undefined;
        break;
      case 'glob_files':
        argPattern = typeof args.pattern === 'string' ? args.pattern : undefined;
        break;
    }
  }

  if (argPattern !== undefined) {
    return `${input.toolName}(${argPattern})`;
  }
  return input.toolName;
}
