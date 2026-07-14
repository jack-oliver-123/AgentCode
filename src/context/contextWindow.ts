/**
 * model 名前缀查表，返回 context window 大小（tokens）。
 * 采用最长前缀优先匹配，按顺序第一条命中即返回。
 */

const PREFIX_TABLE: Array<[string, number]> = [
  ['claude-', 200000],
  ['gpt-4o', 128000],
  ['gpt-4-turbo', 128000],
  ['gpt-4', 8000],
  ['gpt-3.5', 16000],
];

const DEFAULT_CONTEXT_WINDOW = 128000;

export function lookupContextWindow(model: string): number {
  for (const [prefix, size] of PREFIX_TABLE) {
    if (model.startsWith(prefix)) {
      return size;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}
