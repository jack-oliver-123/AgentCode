import { describe, expect, it } from 'vitest';

import { lookupContextWindow } from '../../../src/context/contextWindow.js';

describe('lookupContextWindow', () => {
  it('claude-* 返回 200000', () => {
    expect(lookupContextWindow('claude-3-opus-20240229')).toBe(200000);
  });

  it('gpt-4o* 返回 128000', () => {
    expect(lookupContextWindow('gpt-4o-2024-11-20')).toBe(128000);
  });

  it('gpt-4-turbo* 返回 128000', () => {
    expect(lookupContextWindow('gpt-4-turbo-preview')).toBe(128000);
  });

  it('gpt-4*（非 gpt-4o* 和 gpt-4-turbo*）返回 8000', () => {
    expect(lookupContextWindow('gpt-4-0613')).toBe(8000);
  });

  it('gpt-3.5* 返回 16000', () => {
    expect(lookupContextWindow('gpt-3.5-turbo')).toBe(16000);
  });

  it('未知 model 返回默认值 128000', () => {
    expect(lookupContextWindow('unknown-model-xyz')).toBe(128000);
  });
});
