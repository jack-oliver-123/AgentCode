import type { ToolRisk } from '../types.js';
import type { PermissionCheckInput } from './types.js';

const RISK_LABELS: Record<ToolRisk, string> = {
  read: '[read]',
  write: '[write]',
  execute: '[execute]',
};

const MAX_ARG_DISPLAY_LEN = 100;

/**
 * 构建权限弹窗的描述文本。
 * 包含工具名、risk 类型和参数摘要。
 */
export function buildPromptDescription(input: PermissionCheckInput): string {
  const args = input.parsedArguments as Record<string, unknown> | null;
  let argSummary = '';

  if (args !== null && typeof args === 'object') {
    switch (input.toolName) {
      case 'run_command':
        argSummary = typeof args.command === 'string' ? args.command : '';
        break;
      case 'read_file':
      case 'write_file':
      case 'edit_file':
      case 'search_code':
        argSummary = typeof args.path === 'string' ? args.path : '';
        break;
      case 'glob_files':
        argSummary = typeof args.pattern === 'string' ? args.pattern : '';
        break;
      default:
        argSummary = JSON.stringify(args);
        break;
    }
  }

  if (argSummary.length > MAX_ARG_DISPLAY_LEN) {
    argSummary = `${argSummary.slice(0, MAX_ARG_DISPLAY_LEN)}...`;
  }

  const riskLabel = RISK_LABELS[input.toolRisk];

  return `${riskLabel} ${input.toolName}: ${argSummary}`;
}
