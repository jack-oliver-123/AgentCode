import { describe, expect, it, vi } from 'vitest';

import {
  ReviewRunner,
  ReviewOutputError,
  type ReviewResult,
} from '../../../src/app/review/ReviewRunner.js';
import { ReviewTargetError, type FrozenReviewTarget } from '../../../src/app/review/targetFreeze.js';
import { createStaticRegistry } from '../../../src/tools/registry.js';
import type { ToolDefinition } from '../../../src/tools/types.js';
import { FakeProvider } from '../../helpers/FakeProvider.js';

const frozenTarget: FrozenReviewTarget = {
  kind: 'worktree',
  input: { kind: 'worktree' },
  repoRoot: 'C:\\repo',
  repoIdentity: { host: 'github.com', owner: 'acme', repo: 'project' },
  baseSha: 'head-sha',
  headSha: 'head-sha',
  diff: 'diff --git a/a.ts b/a.ts\n+bug\n',
  diffHash: 'a'.repeat(64),
  metadata: {},
  frozenAt: 100,
};

function tool(name: string, risk: 'read' | 'write'): ToolDefinition {
  return {
    name,
    description: `${risk} tool`,
    risk,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ ok: true, toolName: name, data: {}, meta: { durationMs: 0, timedOut: false } }),
  };
}

function createRunner(
  provider: FakeProvider,
  overrides: { validate?: () => Promise<void>; persist?: (result: ReviewResult) => Promise<void> } = {},
): ReviewRunner {
  return new ReviewRunner({
    provider,
    model: 'review-model',
    toolRegistry: createStaticRegistry([tool('read_file', 'read'), tool('write_file', 'write')]),
    createToolContext: (signal) => ({
      cwd: 'C:\\repo',
      timeoutMs: 1_000,
      secrets: [],
      maxOutputBytes: 10_000,
      ...(signal !== undefined ? { signal } : {}),
    }),
    validateTarget: overrides.validate ?? (async () => undefined),
    persistResult: overrides.persist ?? vi.fn(async () => undefined),
  });
}

describe('ReviewRunner', () => {
  it('runs with isolated context and read-only tools, then persists typed findings', async () => {
    const provider = new FakeProvider([
      {
        type: 'content.delta',
        delta: JSON.stringify({
          findings: [
            {
              severity: 'high',
              file: 'a.ts',
              line: 10,
              title: 'Incorrect branch',
              scenario: 'When input is empty, the wrong branch runs.',
              evidence: 'The condition is inverted.',
            },
          ],
          summary: 'One reportable issue.',
        }),
      },
      { type: 'response.complete' },
    ]);
    const persist = vi.fn(async () => undefined);
    const runner = createRunner(provider, { persist });

    const result = await runner.run(frozenTarget);

    expect(result.findings).toHaveLength(1);
    expect(result.target).not.toHaveProperty('diff');
    expect(result.findings[0]).toMatchObject({ severity: 'high', file: 'a.ts', line: 10 });
    expect(persist).toHaveBeenCalledWith(result);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages).toHaveLength(1);
    expect(provider.requests[0]?.messages[0]).toMatchObject({ role: 'user' });
    expect(provider.requests[0]?.tools?.map((declaration) => declaration.name)).toEqual(['read_file']);
    expect(provider.requests[0]?.system).toContain('只读');
  });

  it('accepts findings: [] as a successful review result', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: JSON.stringify({ findings: [], summary: '未发现符合报告阈值的问题。' }) },
      { type: 'response.complete' },
    ]);

    await expect(createRunner(provider).run(frozenTarget)).resolves.toMatchObject({
      findings: [],
      summary: '未发现符合报告阈值的问题。',
    });
  });

  it('does not start the Provider when frozen target validation fails', async () => {
    const provider = new FakeProvider([]);
    const runner = createRunner(provider, {
      validate: async () => {
        throw new ReviewTargetError('target_changed', 'changed');
      },
    });

    await expect(runner.run(frozenTarget)).rejects.toMatchObject({ code: 'target_changed' });
    expect(provider.requests).toEqual([]);
  });

  it('rejects malformed review output instead of persisting a misleading result', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: '{"findings":[{"severity":"high"}],"summary":"bad"}' },
      { type: 'response.complete' },
    ]);
    const persist = vi.fn(async () => undefined);

    await expect(createRunner(provider, { persist }).run(frozenTarget)).rejects.toBeInstanceOf(ReviewOutputError);
    expect(persist).not.toHaveBeenCalled();
  });
});
