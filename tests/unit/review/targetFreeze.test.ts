import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ReviewTargetError,
  freezeReviewTarget,
  validateFrozenReviewTarget,
  type ReviewCommandOptions,
  type ReviewCommandResult,
  type ReviewCommandRunner,
} from '../../../src/app/review/targetFreeze.js';

interface FakeCommand {
  command: 'git' | 'gh';
  args: readonly string[];
  options?: ReviewCommandOptions;
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createRunner(overrides: Partial<Record<string, Partial<ReviewCommandResult>>> = {}): {
  runner: ReviewCommandRunner;
  calls: FakeCommand[];
} {
  const calls: FakeCommand[] = [];
  const defaults: Record<string, Partial<ReviewCommandResult>> = {
    'git rev-parse --show-toplevel': { stdout: 'C:\\repo\n' },
    'git rev-parse HEAD': { stdout: 'head-sha\n' },
    'git config --get remote.origin.url': { stdout: 'git@github.com:acme/project.git\n' },
    'git diff --binary --no-ext-diff head-sha --': { stdout: 'diff --git a/a.ts b/a.ts\n+change\n' },
    'git ls-files --others --exclude-standard -z': { stdout: '' },
  };
  return {
    calls,
    runner: async (command, args, _cwd, options) => {
      calls.push({ command, args: [...args], ...(options !== undefined ? { options } : {}) });
      const key = `${command} ${args.join(' ')}`;
      const result = overrides[key] ?? defaults[key];
      if (result === undefined) throw new Error(`Unexpected command: ${key}`);
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
        ...(result.aborted === true ? { aborted: true } : {}),
        ...(result.timedOut === true ? { timedOut: true } : {}),
      };
    },
  };
}

describe('freezeReviewTarget', () => {
  it('freezes a worktree by HEAD, diff bytes, repo identity, and deterministic hash', async () => {
    const { runner, calls } = createRunner();
    const signal = new AbortController().signal;

    const target = await freezeReviewTarget(
      { kind: 'worktree', focus: 'security' },
      { cwd: 'C:\\repo', run: runner, now: () => 100, signal, commandTimeoutMs: 1234 },
    );

    expect(target).toMatchObject({
      kind: 'worktree',
      repoRoot: 'C:\\repo',
      repoIdentity: { host: 'github.com', owner: 'acme', repo: 'project' },
      baseSha: 'head-sha',
      headSha: 'head-sha',
      focus: 'security',
      frozenAt: 100,
    });
    expect(target.diff).toContain('+change');
    expect(target.diffHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(calls.every((call) => call.options?.signal === signal && call.options.timeoutMs === 1234)).toBe(true);
  });

  it.each([
    ['cancelled', { aborted: true }],
    ['preflight_timeout', { timedOut: true }],
  ] as const)('classifies bounded preflight termination as %s', async (code, result) => {
    const { runner } = createRunner({
      'git rev-parse --show-toplevel': result,
    });

    await expect(freezeReviewTarget({ kind: 'worktree' }, { cwd: 'C:\\repo', run: runner }))
      .rejects.toMatchObject({ code });
  });

  it('rejects untracked files that cannot be represented by the frozen snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentcode-review-large-'));
    tempRoots.push(root);
    await writeFile(join(root, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const { runner } = createRunner({
      'git rev-parse --show-toplevel': { stdout: `${root}\n` },
      'git ls-files --others --exclude-standard -z': { stdout: 'large.bin\0' },
    });

    await expect(freezeReviewTarget({ kind: 'worktree' }, { cwd: root, run: runner }))
      .rejects.toMatchObject({ code: 'target_not_found', message: expect.stringContaining('snapshot limit') });
  });

  it('resolves a branch to immutable base/head SHAs and diffs only those SHAs', async () => {
    const { runner, calls } = createRunner({
      'git rev-parse --verify --end-of-options main^{commit}': { stdout: 'base-sha\n' },
      'git diff --binary --no-ext-diff base-sha...head-sha --': { stdout: 'branch diff' },
    });

    const target = await freezeReviewTarget({ kind: 'branch', branch: 'main' }, { cwd: 'C:\\repo', run: runner });

    expect(target).toMatchObject({ kind: 'branch', baseSha: 'base-sha', headSha: 'head-sha' });
    expect(target.metadata).toMatchObject({ branch: 'main' });
    expect(calls).toContainEqual(expect.objectContaining({
      command: 'git',
      args: ['diff', '--binary', '--no-ext-diff', 'base-sha...head-sha', '--'],
    }));
  });

  it('rejects a GitHub PR URL for another repository before requesting PR data', async () => {
    const { runner, calls } = createRunner();

    await expect(
      freezeReviewTarget(
        { kind: 'pr', target: 'https://github.com/other/project/pull/7' },
        { cwd: 'C:\\repo', run: runner },
      ),
    ).rejects.toMatchObject({ code: 'repo_mismatch' });
    expect(calls.some((call) => call.command === 'gh')).toBe(false);
  });

  it('freezes fork PRs from API base/head SHAs and the API diff without local checkout', async () => {
    const metadata = JSON.stringify({
      number: 7,
      html_url: 'https://github.com/acme/project/pull/7',
      base: { sha: 'base-pr', repo: { full_name: 'acme/project' } },
      head: { sha: 'head-pr', repo: { full_name: 'contributor/project' } },
    });
    const { runner, calls } = createRunner({
      'gh api repos/acme/project/pulls/7': { stdout: metadata },
      'gh api repos/acme/project/pulls/7 -H Accept: application/vnd.github.v3.diff': { stdout: 'frozen pr diff' },
    });

    const target = await freezeReviewTarget({ kind: 'pr', target: '7' }, { cwd: 'C:\\repo', run: runner });

    expect(target).toMatchObject({
      kind: 'pr',
      baseSha: 'base-pr',
      headSha: 'head-pr',
      metadata: { prNumber: '7', baseRepo: 'acme/project', headRepo: 'contributor/project' },
    });
    expect(target.diff).toBe('frozen pr diff');
    expect(calls.filter((call) => call.command === 'gh')).toHaveLength(3);
    expect(calls.some((call) => call.command === 'git' && call.args[0] === 'fetch')).toBe(false);
  });

  it.each([
    ['auth_required', 'not logged into any GitHub hosts'],
    ['network_unavailable', 'could not resolve host github.com'],
    ['rate_limited', 'API rate limit exceeded'],
    ['target_not_found', 'HTTP 404: Not Found'],
  ] as const)('classifies explicit PR failures as %s without fallback', async (code, stderr) => {
    const { runner } = createRunner({
      'gh api repos/acme/project/pulls/7': { stderr, exitCode: 1 },
    });

    await expect(
      freezeReviewTarget({ kind: 'pr', target: '7' }, { cwd: 'C:\\repo', run: runner }),
    ).rejects.toMatchObject({ code });
  });

  it('detects target changes before ReviewRunner starts', async () => {
    const first = createRunner();
    const frozen = await freezeReviewTarget({ kind: 'worktree' }, { cwd: 'C:\\repo', run: first.runner });
    const changed = createRunner({
      'git diff --binary --no-ext-diff head-sha --': { stdout: 'changed diff' },
    });

    await expect(
      validateFrozenReviewTarget(frozen, { cwd: 'C:\\repo', run: changed.runner }),
    ).rejects.toBeInstanceOf(ReviewTargetError);
    await expect(
      validateFrozenReviewTarget(frozen, { cwd: 'C:\\repo', run: changed.runner }),
    ).rejects.toMatchObject({ code: 'target_changed' });
  });
});
