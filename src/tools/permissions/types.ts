import type { ToolExecutionError, ToolRisk } from '../types.js';

// ─── 权限模式 ────────────────────────────────────────────────

export type PermissionMode = 'plan' | 'strict' | 'normal' | 'auto' | 'yolo';

// ─── 权限判定结果（discriminated union）─────────────────────

export type PermissionDecision =
  | { allowed: true; source: PermissionSource }
  | { allowed: false; error: ToolExecutionError; source: PermissionSource };

/** 判定来源（用于错误信息和调试） */
export type PermissionSource =
  | 'blacklist'
  | 'path_sandbox'
  | 'rule_allow'
  | 'rule_deny'
  | 'auto_safety'
  | 'mode_default'
  | 'session_grant'
  | 'user_prompt';

// ─── 权限检查输入 ────────────────────────────────────────────

export interface PermissionCheckInput {
  toolName: string;
  toolRisk: ToolRisk;
  parsedArguments: unknown;
  cwd: string;
}

// ─── 规则定义 ────────────────────────────────────────────────

/** YAML 中的原始规则 */
export interface PermissionRule {
  rule: string; // "tool_name(glob_pattern)"
  action: 'allow' | 'deny';
}

/** 编译后的规则（解析 tool name 和 pattern 后） */
export interface CompiledRule {
  toolName: string;
  argPattern: string | undefined; // glob pattern，undefined = 匹配所有
  matcher: ((target: string) => boolean) | undefined;
  action: 'allow' | 'deny';
}

// ─── 规则配置（三层）────────────────────────────────────────

export interface PermissionRuleConfig {
  session: readonly CompiledRule[];
  project: readonly CompiledRule[];
  global: readonly CompiledRule[];
}

// ─── TUI 弹窗回调（注入接口）────────────────────────────────

export type AskPermissionFn = (
  input: PermissionCheckInput,
  description: string,
) => Promise<PromptResponse>;

export type PromptResponse =
  | { action: 'allow_once' }
  | { action: 'allow_session' }
  | { action: 'allow_permanent' }
  | { action: 'deny' };

// ─── PermissionChecker 接口 ──────────────────────────────────

export interface PermissionChecker {
  check(input: PermissionCheckInput): Promise<PermissionDecision>;
  addSessionRule(rule: CompiledRule): void;
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
}
