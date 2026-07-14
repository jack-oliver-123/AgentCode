import type {
  AskPermissionFn,
  CompiledRule,
  PermissionCheckInput,
  PermissionChecker,
  PermissionDecision,
  PermissionMode,
  PermissionRuleConfig,
  PromptResponse,
} from './types.js';

import { checkAutoSafety } from './autoSafety.js';
import { checkBlacklist } from './blacklist.js';
import { appendProjectRule } from './config.js';
import { applyModeDefault } from './modePolicy.js';
import { checkPathSandbox } from './pathSandbox.js';
import { buildPromptDescription } from './promptDescription.js';
import { extractMatchTarget, matchRules } from './ruleEngine.js';
import { compileRule } from './ruleParser.js';

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
  const sessionRules = [...options.ruleConfig.session];
  const ruleConfig: PermissionRuleConfig = {
    session: sessionRules,
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

    // plan 模式下 write/execute 不可被配置规则放开
    if (currentMode === 'plan' && input.toolRisk !== 'read') {
      const planResult = applyModeDefault(input, currentMode);
      if (planResult !== 'needs_prompt') {
        return planResult;
      }
    }

    // Layer 3: 规则引擎（session → project → global）
    const ruleResult = matchRules(input, ruleConfig);
    if (ruleResult !== undefined) {
      return ruleResult;
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
    let response: PromptResponse;
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
        sessionRules.unshift(buildRuleFromInput(input));
        return { allowed: true, source: 'session_grant' };
      }

      case 'allow_permanent': {
        const ruleString = buildRuleString(input);
        sessionRules.unshift(compileRule({ rule: ruleString, action: 'allow' }));
        try {
          appendProjectRule(options.cwd, ruleString);
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
    sessionRules.unshift(rule);
  }

  function getMode(): PermissionMode {
    return currentMode;
  }

  function setMode(mode: PermissionMode): void {
    currentMode = mode;
  }

  return { check, addSessionRule, getMode, setMode };
}

function buildRuleFromInput(input: PermissionCheckInput): CompiledRule {
  return compileRule({ rule: buildRuleString(input), action: 'allow' });
}

function buildRuleString(input: PermissionCheckInput): string {
  const target = extractMatchTarget(input);
  return target === undefined ? input.toolName : `${input.toolName}(${target})`;
}
