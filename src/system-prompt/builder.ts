import type { SystemPromptBuildInput, SystemPromptBuildOutput, SystemPromptModule } from './types.js';
import { defaultRegistry } from './registry.js';

export function buildSystemPrompt(
  input: SystemPromptBuildInput,
  registry?: SystemPromptModule[],
): SystemPromptBuildOutput {
  const modules = registry ?? defaultRegistry;

  // system 构建
  const disabledSet = new Set((input.disabled ?? []).filter(Boolean));
  const enabledModules = modules
    .filter(m => !disabledSet.has(m.id) && m.content.length > 0)
    .sort((a, b) => a.order - b.order);
  const system = enabledModules.map(m => m.content).join('\n\n');

  // reminder 构建
  const parts: string[] = [];

  // 1. 环境上下文
  if (input.env) {
    let envLine = `OS: ${input.env.os} | Shell: ${input.env.shell} | CWD: ${input.env.cwd} | Date: ${input.env.date}`;
    if (input.env.gitBranch !== undefined) {
      const dirtyFlag = input.env.gitDirty === true ? ' [dirty]' : '';
      envLine += ` | Git: ${input.env.gitBranch}${dirtyFlag}`;
    }
    parts.push(envLine);
  }

  // 2. 模式指令（full 模式跳过）
  if (input.mode !== 'full') {
    const interval = Math.max(1, Math.floor(input.reminderInterval ?? 4));
    const isFullReminder = input.turnIndex === 0 || input.turnIndex % interval === 0;
    if (isFullReminder) {
      // 完整版（模式标识 + 核心约束）
      parts.push(`当前模式: ${input.mode} | 仅输出结构化计划，不直接修改文件`);
    } else {
      // 精简版（仅模式标识）
      parts.push(`mode: ${input.mode}`);
    }
  }

  // 3. plan 上下文
  if (input.plan && input.plan.length > 0) {
    const planLines = input.plan.map((step, i) => `Step ${i + 1}: ${step.title} - ${step.description}`);
    parts.push(`<active-plan>\n${planLines.join('\n')}\n</active-plan>`);
  }

  const reminder = parts.join('\n');

  return { system, reminder };
}
