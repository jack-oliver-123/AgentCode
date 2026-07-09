import type { ToolExecutionResult } from './types.js';

/**
 * 为工具执行结果生成单行安全摘要（不暴露 secrets 或原始参数）
 */
export function summarizeToolResult(result: ToolExecutionResult): string {
  if (!result.ok) {
    return `${result.toolName} ✗ ${result.error.code}`;
  }

  const data = result.data as Record<string, unknown> | undefined;

  switch (result.toolName) {
    case 'read_file':
      return formatReadFile(data);
    case 'write_file':
      return formatWriteFile(data);
    case 'edit_file':
      return formatEditFile(data);
    case 'run_command':
      return formatRunCommand(data);
    case 'glob_files':
      return formatGlobFiles(data);
    case 'search_code':
      return formatSearchCode(data);
    case 'submit_plan':
      return formatSubmitPlan(data);
    default:
      return result.toolName;
  }
}

function formatReadFile(data: Record<string, unknown> | undefined): string {
  const path = getString(data, 'path') ?? 'file';
  const bytes = getNumber(data, 'bytes');
  return bytes !== undefined ? `read_file: ${path} (${formatBytes(bytes)})` : `read_file: ${path}`;
}

function formatWriteFile(data: Record<string, unknown> | undefined): string {
  const path = getString(data, 'path') ?? 'file';
  const bytes = getNumber(data, 'bytes');
  return bytes !== undefined ? `write_file: ${path} (${formatBytes(bytes)} written)` : `write_file: ${path}`;
}

function formatEditFile(data: Record<string, unknown> | undefined): string {
  const path = getString(data, 'path') ?? 'file';
  return `edit_file: ${path}`;
}

function formatRunCommand(data: Record<string, unknown> | undefined): string {
  const command = getString(data, 'command') ?? 'command';
  const exitCode = getNumber(data, 'exitCode');
  const truncatedCmd = command.length > 40 ? `${command.slice(0, 37)}...` : command;
  return exitCode !== undefined ? `run_command: ${truncatedCmd} (exit ${exitCode})` : `run_command: ${truncatedCmd}`;
}

function formatGlobFiles(data: Record<string, unknown> | undefined): string {
  const pattern = getString(data, 'pattern') ?? 'pattern';
  const matches = Array.isArray(data?.['matches']) ? data['matches'].length : getNumber(data, 'count');
  return matches !== undefined ? `glob_files: ${pattern} (${matches} matches)` : `glob_files: ${pattern}`;
}

function formatSearchCode(data: Record<string, unknown> | undefined): string {
  const query = getString(data, 'query') ?? 'query';
  const matches = Array.isArray(data?.['matches']) ? data['matches'].length : getNumber(data, 'count');
  const truncatedQuery = query.length > 30 ? `${query.slice(0, 27)}...` : query;
  return matches !== undefined
    ? `search_code: "${truncatedQuery}" (${matches} matches)`
    : `search_code: "${truncatedQuery}"`;
}

function formatSubmitPlan(data: Record<string, unknown> | undefined): string {
  const steps = Array.isArray(data?.['steps']) ? data['steps'].length : 0;
  return `submit_plan: ${steps} steps`;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key];
  return typeof value === 'number' ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
