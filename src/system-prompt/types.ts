import type { PlanStep } from '../agent/types.js';

// ─── 模块注册表条目 ─────────────────────────────────────────────────────

/** 系统提示模块（注册表条目） */
export interface SystemPromptModule {
  /** 唯一标识 */
  id: string;
  /** 拼装顺序号，越小越靠前 */
  order: number;
  /** 模块文本内容（空字符串 = 占位不拼装） */
  content: string;
}

// ─── 环境上下文 ─────────────────────────────────────────────────────────

/** 运行环境上下文 */
export interface EnvContext {
  /** 操作系统，如 'win32'、'darwin'、'linux' */
  os: string;
  /** Shell 类型，如 'bash'、'powershell' */
  shell: string;
  /** 当前工作目录 */
  cwd: string;
  /** ISO 日期字符串，如 '2026-07-08' */
  date: string;
}

// ─── 构建器 I/O ─────────────────────────────────────────────────────────

/** 系统提示构建器输入 */
export interface SystemPromptBuildInput {
  /** 运行模式 */
  mode: 'full' | 'plan';
  /** 当前轮次索引（从 0 开始，每轮 +1） */
  turnIndex: number;
  /** 当前活跃计划步骤 */
  plan?: PlanStep[];
  /** 环境上下文 */
  env?: EnvContext;
  /** 要禁用的模块 ID 列表 */
  disabled?: string[];
  /** reminder 频率控制间隔 N，默认 4，最小 1 */
  reminderInterval?: number;
}

/** 系统提示构建器输出 */
export interface SystemPromptBuildOutput {
  /** 所有启用模块拼装的完整文本（会话内稳定） */
  system: string;
  /** 当前轮 system-reminder 文本（可能为空） */
  reminder: string;
}

/** 系统提示构建器函数签名 */
export type SystemPromptBuilder = (
  input: SystemPromptBuildInput,
  registry?: SystemPromptModule[],
) => SystemPromptBuildOutput;
