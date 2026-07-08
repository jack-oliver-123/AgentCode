import { describe, expect, it } from 'vitest';

import { enhanceToolDeclarations } from '../../../src/system-prompt/enhanceToolDeclarations.js';
import type { ProviderToolDeclaration } from '../../../src/tools/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function makeDeclaration(name: string, description = `${name} description`): ProviderToolDeclaration {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

// ─── AC5: 增强工具描述包含预期引导 ──────────────────────────────────────

describe('enhanceToolDeclarations - 增强工具描述', () => {
  it('edit_file description 包含 read_file 引导', () => {
    const declarations = [makeDeclaration('edit_file')];
    const enhanced = enhanceToolDeclarations(declarations);
    expect(enhanced[0]!.description).toContain('read_file');
  });

  it('write_file description 包含 edit_file 引导', () => {
    const declarations = [makeDeclaration('write_file')];
    const enhanced = enhanceToolDeclarations(declarations);
    expect(enhanced[0]!.description).toContain('edit_file');
  });

  it('run_command description 包含专用工具引导', () => {
    const declarations = [makeDeclaration('run_command')];
    const enhanced = enhanceToolDeclarations(declarations);
    expect(enhanced[0]!.description).toContain('专用工具');
  });
});

// ─── AC5a: 未增强的工具描述不变 ─────────────────────────────────────────

describe('enhanceToolDeclarations - 未增强工具不受影响', () => {
  it('read_file description 保持原样', () => {
    const original = makeDeclaration('read_file', 'Read a file from disk');
    const enhanced = enhanceToolDeclarations([original]);
    expect(enhanced[0]!.description).toBe('Read a file from disk');
  });

  it('glob_files description 保持原样', () => {
    const original = makeDeclaration('glob_files', 'Glob for files');
    const enhanced = enhanceToolDeclarations([original]);
    expect(enhanced[0]!.description).toBe('Glob for files');
  });

  it('search_code description 保持原样', () => {
    const original = makeDeclaration('search_code', 'Search code');
    const enhanced = enhanceToolDeclarations([original]);
    expect(enhanced[0]!.description).toBe('Search code');
  });
});

// ─── 不 mutate 原始数组 ─────────────────────────────────────────────────

describe('enhanceToolDeclarations - 不修改原始输入', () => {
  it('原始 declarations 数组引用和内容不被修改', () => {
    const declarations = [
      makeDeclaration('edit_file', 'Edit a file'),
      makeDeclaration('read_file', 'Read a file'),
    ];
    const originalDescriptions = declarations.map((d) => d.description);

    const enhanced = enhanceToolDeclarations(declarations);

    // 返回值是新数组
    expect(enhanced).not.toBe(declarations);
    // 原始数组中的 description 不变
    expect(declarations.map((d) => d.description)).toEqual(originalDescriptions);
  });
});
