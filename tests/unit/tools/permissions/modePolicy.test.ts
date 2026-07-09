import { describe, it, expect } from 'vitest';

import { applyModeDefault } from '../../../../src/tools/permissions/modePolicy.js';
import type { PermissionCheckInput } from '../../../../src/tools/permissions/types.js';

const dummyInput: PermissionCheckInput = {
  toolName: 'run_command',
  toolRisk: 'write',
  parsedArguments: { command: 'echo hello' },
  cwd: '/workspace',
};

describe('applyModeDefault', () => {
  it('strict → deny (mode_default)', () => {
    const result = applyModeDefault(dummyInput, 'strict');
    expect(result).not.toBe('needs_prompt');
    if (result !== 'needs_prompt') {
      expect(result.allowed).toBe(false);
      expect(result.source).toBe('mode_default');
    }
  });

  it('normal → needs_prompt', () => {
    const result = applyModeDefault(dummyInput, 'normal');
    expect(result).toBe('needs_prompt');
  });

  it('auto → needs_prompt', () => {
    const result = applyModeDefault(dummyInput, 'auto');
    expect(result).toBe('needs_prompt');
  });

  it('yolo → allow (mode_default)', () => {
    const result = applyModeDefault(dummyInput, 'yolo');
    expect(result).not.toBe('needs_prompt');
    if (result !== 'needs_prompt') {
      expect(result.allowed).toBe(true);
      expect(result.source).toBe('mode_default');
    }
  });

  it('plan → deny (mode_default)', () => {
    const result = applyModeDefault(dummyInput, 'plan');
    expect(result).not.toBe('needs_prompt');
    if (result !== 'needs_prompt') {
      expect(result.allowed).toBe(false);
      expect(result.source).toBe('mode_default');
    }
  });
});
