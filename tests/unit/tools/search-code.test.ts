import { symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSearchCodeTool } from '../../../src/tools/builtins/search-code.js';
import { createWorkspace, executeFileTool, writeWorkspaceFile } from './file-test-helpers.js';

const SENTINEL_SECRET = 'sk-agentcode-e2e-secret-should-not-appear';

describe('search_code', () => {
  it('finds literal text matches with path, line, and preview', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'first line\nneedle is here\nlast line');
    await writeWorkspaceFile(workspace, 'src/other.ts', 'no match');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      toolName: 'search_code',
      data: {
        matches: [
          {
            path: 'src/index.ts',
            line: 2,
            preview: 'needle is here'
          }
        ],
        truncated: false
      },
      meta: {
        truncated: false
      }
    });
  });

  it('supports regular expression searches and include globs', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/app.ts', 'const answer = 42;');
    await writeWorkspaceFile(workspace, 'docs/app.md', 'answer = 42');

    const result = await executeSearchCode(JSON.stringify({ query: 'answer\\s*=\\s*\\d+', regex: true, include: 'src/**/*.ts' }), {
      cwd: workspace
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'src/app.ts',
            line: 1,
            preview: 'const answer = 42;'
          }
        ],
        truncated: false
      }
    });
  });

  it('allows common optional-group regular expressions', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/app.ts', 'const answer = 42;');

    const result = await executeSearchCode(JSON.stringify({ query: '(?:const\\s+)?answer\\s*=\\s*\\d+', regex: true }), {
      cwd: workspace
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'src/app.ts',
            preview: 'const answer = 42;'
          }
        ]
      }
    });
  });

  it('allows repeated groups that do not contain risky nested patterns', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'pairs.txt', 'abab foo/foo/bar foo skip bar skip baz skip qux');

    const nonCapturingResult = await executeSearchCode(JSON.stringify({ query: '(?:ab){2}', regex: true }), { cwd: workspace });
    const namedGroupResult = await executeSearchCode(JSON.stringify({ query: '(?<pair>ab){2}', regex: true }), { cwd: workspace });
    const slashGroupResult = await executeSearchCode(JSON.stringify({ query: '(?:foo/)+bar', regex: true }), { cwd: workspace });
    const lazyResult = await executeSearchCode(JSON.stringify({ query: 'foo.*?bar.*?baz.*?qux', regex: true }), { cwd: workspace });

    expect(nonCapturingResult).toMatchObject({
      ok: true,
      data: {
        matches: [{ path: 'pairs.txt' }]
      }
    });
    expect(namedGroupResult).toMatchObject({
      ok: true,
      data: {
        matches: [{ path: 'pairs.txt' }]
      }
    });
    expect(slashGroupResult).toMatchObject({
      ok: true,
      data: {
        matches: [{ path: 'pairs.txt' }]
      }
    });
    expect(lazyResult).toMatchObject({
      ok: true,
      data: {
        matches: [{ path: 'pairs.txt' }]
      }
    });
  });

  it('skips noisy directories by default', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'needle');
    await writeWorkspaceFile(workspace, '.git/config', 'needle');
    await writeWorkspaceFile(workspace, 'node_modules/pkg/index.ts', 'needle');
    await writeWorkspaceFile(workspace, 'dist/index.ts', 'needle');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'src/index.ts'
          }
        ],
        truncated: false
      }
    });
  });

  it('limits result count and marks search output as truncated', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'a.txt', 'needle');
    await writeWorkspaceFile(workspace, 'b.txt', 'needle');
    await writeWorkspaceFile(workspace, 'c.txt', 'needle');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle', maxResults: 2 }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          { path: 'a.txt' },
          { path: 'b.txt' }
        ],
        truncated: true
      },
      meta: {
        truncated: true
      }
    });
  });

  it('limits matches within a single file before collecting every matching line', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'many.txt', 'needle\nneedle\nneedle');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle', maxResults: 2 }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          { path: 'many.txt', line: 1 },
          { path: 'many.txt', line: 2 }
        ],
        truncated: true
      }
    });
  });

  it('does not mark output truncated when matches exactly reach the requested limit', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'a.txt', 'needle');
    await writeWorkspaceFile(workspace, 'z.txt', 'not here');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle', maxResults: 1 }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          { path: 'a.txt', line: 1 }
        ],
        truncated: false
      }
    });
  });

  it('skips directory links that point outside the workspace', async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'needle');
    await writeWorkspaceFile(outside, 'secret.txt', 'needle outside');
    await symlink(outside, join(workspace, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'src/index.ts',
            line: 1,
            preview: 'needle'
          }
        ],
        truncated: false
      }
    });
  });

  it('redacts previews before returning search results', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'secret.txt', `token=${SENTINEL_SECRET}`);

    const result = await executeSearchCode(JSON.stringify({ query: 'token=' }), {
      cwd: workspace,
      secrets: [SENTINEL_SECRET]
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'secret.txt',
            preview: 'token=<redacted>'
          }
        ]
      }
    });
    expect(JSON.stringify(result)).not.toContain('sk-agentcode');
  });

  it('centers previews around matches that appear late in a long line', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'late.txt', `${'x'.repeat(200)}needle suffix`);

    const result = await executeSearchCode(JSON.stringify({ query: 'needle' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'late.txt'
          }
        ]
      }
    });
    expect(JSON.stringify(result)).toContain('needle');
  });

  it('redacts full lines before choosing the preview window', async () => {
    const workspace = await createWorkspace();
    const longSecret = `sk-${'a'.repeat(160)}`;
    await writeWorkspaceFile(workspace, 'split-secret.txt', `${longSecret} needle`);

    const result = await executeSearchCode(JSON.stringify({ query: 'needle' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'split-secret.txt'
          }
        ]
      }
    });
    expect(JSON.stringify(result)).toContain('needle');
    expect(JSON.stringify(result)).not.toContain('aaaa');
  });

  it('skips files larger than the search size limit before matching content', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'large.txt', `${'x'.repeat(1024 * 1024 + 1)}needle`);
    await writeWorkspaceFile(workspace, 'small.txt', 'needle');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'small.txt',
            line: 1,
            preview: 'needle'
          }
        ],
        truncated: true
      }
    });
  });

  it('truncates long previews without splitting multi-byte UTF-8 characters', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'unicode.txt', `needle ${'猫'.repeat(100)}`);

    const result = await executeSearchCode(JSON.stringify({ query: 'needle' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'unicode.txt',
            preview: `needle ${'猫'.repeat(51)}`
          }
        ]
      }
    });
  });

  it('marks regex searches truncated when long lines are skipped', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'long-line.txt', `${'x'.repeat(5000)} needle`);

    const result = await executeSearchCode(JSON.stringify({ query: 'needle', regex: true }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [],
        truncated: true
      },
      meta: {
        truncated: true
      }
    });
  });

  it('continues searching later files after skipping long regex lines', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'a-long.txt', `${'x'.repeat(5000)} needle`);
    await writeWorkspaceFile(workspace, 'z-match.txt', 'needle');

    const result = await executeSearchCode(JSON.stringify({ query: 'needle', regex: true }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'z-match.txt',
            preview: 'needle'
          }
        ],
        truncated: true
      }
    });
  });

  it('rejects invalid regular expressions', async () => {
    const workspace = await createWorkspace();

    const result = await executeSearchCode(JSON.stringify({ query: '[', regex: true }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'search_code',
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects regular expressions with nested quantifiers before searching', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'slow.txt', `${'a'.repeat(1000)}!`);

    const result = await executeSearchCode(JSON.stringify({ query: '(a+)+$', regex: true }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'search_code',
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects repeated optional and bounded quantifier groups before searching', async () => {
    const workspace = await createWorkspace();

    const optionalResult = await executeSearchCode(JSON.stringify({ query: '(a?)+$', regex: true }), { cwd: workspace });
    const boundedResult = await executeSearchCode(JSON.stringify({ query: '(a{1,2})+$', regex: true }), { cwd: workspace });

    expect(optionalResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    expect(boundedResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects repeated alternation groups before searching', async () => {
    const workspace = await createWorkspace();

    const result = await executeSearchCode(JSON.stringify({ query: '(a|aa)+$', regex: true }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects repeated groups that contain nested risky groups', async () => {
    const workspace = await createWorkspace();

    const nestedQuantifierResult = await executeSearchCode(JSON.stringify({ query: '((a)+)+$', regex: true }), { cwd: workspace });
    const nestedAlternationResult = await executeSearchCode(JSON.stringify({ query: '((a|aa))+$', regex: true }), { cwd: workspace });
    const nestedNonCapturingResult = await executeSearchCode(JSON.stringify({ query: '(?:(?:a+))+$', regex: true }), { cwd: workspace });

    expect(nestedQuantifierResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    expect(nestedAlternationResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    expect(nestedNonCapturingResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects long ambiguous optional quantifier chains before searching', async () => {
    const workspace = await createWorkspace();

    const bareResult = await executeSearchCode(JSON.stringify({ query: 'a?a?a?a?aaaa', regex: true }), { cwd: workspace });
    const capturingGroupResult = await executeSearchCode(JSON.stringify({ query: '(a)?(a)?(a)?(a)?aaaa', regex: true }), { cwd: workspace });
    const nonCapturingGroupResult = await executeSearchCode(JSON.stringify({ query: '(?:a)?(?:a)?(?:a)?(?:a)?aaaa', regex: true }), { cwd: workspace });

    expect(bareResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    expect(capturingGroupResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    expect(nonCapturingGroupResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects regular expression backreferences before searching', async () => {
    const workspace = await createWorkspace();

    const numericResult = await executeSearchCode(JSON.stringify({ query: '(a)\\1', regex: true }), { cwd: workspace });
    const namedResult = await executeSearchCode(JSON.stringify({ query: '(?<letter>a)\\k<letter>', regex: true }), { cwd: workspace });
    const escapedBackslashResult = await executeSearchCode(JSON.stringify({ query: String.raw`(a)\\\1`, regex: true }), { cwd: workspace });

    expect(numericResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    expect(namedResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    expect(escapedBackslashResult).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects invalid include patterns', async () => {
    const workspace = await createWorkspace();

    const result = await executeSearchCode(JSON.stringify({ query: 'needle', include: '../*.ts' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects invalid argument shapes before searching', async () => {
    const workspace = await createWorkspace();

    const result = await executeSearchCode(JSON.stringify({ query: '', maxResults: 0 }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });
});

function executeSearchCode(argumentsText: string, context: Parameters<typeof executeFileTool>[2]) {
  return executeFileTool(createSearchCodeTool(), argumentsText, {
    timeoutMs: 5000,
    ...context
  });
}
