import type { PermissionCheckInput, PermissionDecision, PermissionMode } from './types.js';

/**
 * 模式策略层：管道最后一层兜底。
 * 按当前模式返回明确判定或 'needs_prompt' 信号。
 */
export function applyModeDefault(
  _input: PermissionCheckInput,
  mode: PermissionMode,
): PermissionDecision | 'needs_prompt' {
  switch (mode) {
    case 'strict':
      return {
        allowed: false,
        error: {
          code: 'permission_denied',
          message: 'Operation not explicitly allowed in strict mode.',
          retryable: false,
        },
        source: 'mode_default',
      };

    case 'normal':
    case 'auto':
      return 'needs_prompt';

    case 'yolo':
      return { allowed: true, source: 'mode_default' };

    case 'plan':
      if (_input.toolRisk === 'read') {
        return { allowed: true, source: 'mode_default' };
      }
      return {
        allowed: false,
        error: {
          code: 'permission_denied',
          message: 'Operation not available in plan mode.',
          retryable: false,
        },
        source: 'mode_default',
      };
  }
}
