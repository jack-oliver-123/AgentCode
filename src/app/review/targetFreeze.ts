import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { readSafeFile } from '../../shared/safeFs.js';

const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export type ReviewTargetInput =
  | { kind: 'worktree'; focus?: string }
  | { kind: 'branch'; branch: string; focus?: string }
  | { kind: 'pr'; target: string; focus?: string };

export interface FrozenReviewTarget {
  kind: 'worktree' | 'branch' | 'pr';
  input: ReviewTargetInput;
  repoRoot: string;
  repoIdentity?: { host: 'github.com'; owner: string; repo: string };
  baseSha: string;
  headSha: string;
  diff: string;
  diffHash: string;
  focus?: string;
  metadata: Readonly<Record<string, string>>;
  frozenAt: number;
}

export type ReviewTargetErrorCode =
  | 'auth_required'
  | 'network_unavailable'
  | 'rate_limited'
  | 'target_not_found'
  | 'repo_mismatch'
  | 'target_changed'
  | 'cancelled'
  | 'preflight_timeout';

export class ReviewTargetError extends Error {
  constructor(readonly code: ReviewTargetErrorCode, message: string) {
    super(message);
    this.name = 'ReviewTargetError';
  }
}

export interface ReviewCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
  timedOut?: boolean;
}

export interface ReviewCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ReviewCommandRunner = (
  command: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
  options?: ReviewCommandOptions,
) => Promise<ReviewCommandResult>;

export interface FreezeReviewTargetOptions {
  cwd: string;
  run?: ReviewCommandRunner;
  now?: () => number;
  signal?: AbortSignal;
  commandTimeoutMs?: number;
}

interface PullRequestMetadata {
  number: number;
  htmlUrl: string;
  baseSha: string;
  headSha: string;
  baseRepo: string;
  headRepo: string;
}

export async function freezeReviewTarget(
  input: ReviewTargetInput,
  options: FreezeReviewTargetOptions,
): Promise<FrozenReviewTarget> {
  const commandRunner = options.run ?? runReviewCommand;
  const run: ReviewCommandRunner = async (command, args, cwd) => {
    const result = await commandRunner(command, args, cwd, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    if (result.aborted || options.signal?.aborted) {
      throw new ReviewTargetError('cancelled', `Review preflight command was cancelled: ${command} ${args[0] ?? ''}`.trim());
    }
    if (result.timedOut) {
      throw new ReviewTargetError('preflight_timeout', `Review preflight command timed out: ${command} ${args[0] ?? ''}`.trim());
    }
    return result;
  };
  const repoRoot = await resolveRepoRoot(options.cwd, run);
  const repoIdentity = await resolveRepoIdentity(repoRoot, run);
  const frozenAt = (options.now ?? Date.now)();

  if (input.kind === 'worktree') {
    const headSha = await resolveHead(repoRoot, run);
    const diff = await freezeWorktreeDiff(repoRoot, headSha, run);
    return buildFrozenTarget({
      kind: 'worktree',
      input,
      repoRoot,
      ...(repoIdentity !== undefined ? { repoIdentity } : {}),
      baseSha: headSha,
      headSha,
      diff,
      ...(input.focus !== undefined ? { focus: input.focus } : {}),
      metadata: {},
      frozenAt,
    });
  }

  if (input.kind === 'branch') {
    const branch = input.branch.trim();
    if (branch.length === 0 || branch.startsWith('-')) {
      throw new ReviewTargetError('target_not_found', `Invalid branch target: ${input.branch}`);
    }
    const headSha = await resolveHead(repoRoot, run);
    const baseResult = await run('git', ['rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`], repoRoot);
    if (baseResult.exitCode !== 0) {
      throw new ReviewTargetError('target_not_found', `Branch target not found: ${branch}`);
    }
    const baseSha = baseResult.stdout.trim();
    const diff = await requireCommand(
      run('git', ['diff', '--binary', '--no-ext-diff', `${baseSha}...${headSha}`, '--'], repoRoot),
      'target_not_found',
      `Unable to diff branch target: ${branch}`,
    );
    return buildFrozenTarget({
      kind: 'branch',
      input,
      repoRoot,
      ...(repoIdentity !== undefined ? { repoIdentity } : {}),
      baseSha,
      headSha,
      diff: diff.stdout,
      ...(input.focus !== undefined ? { focus: input.focus } : {}),
      metadata: { branch },
      frozenAt,
    });
  }

  if (repoIdentity === undefined) {
    throw new ReviewTargetError('repo_mismatch', 'The current repository has no canonical github.com origin.');
  }
  const pr = parsePullRequestTarget(input.target, repoIdentity);
  const endpoint = `repos/${repoIdentity.owner}/${repoIdentity.repo}/pulls/${pr.number}`;
  const before = await fetchPullRequestMetadata(endpoint, repoRoot, run);
  if (before.baseRepo.toLocaleLowerCase() !== `${repoIdentity.owner}/${repoIdentity.repo}`.toLocaleLowerCase()) {
    throw new ReviewTargetError('repo_mismatch', `PR base repository does not match the current repository: ${before.baseRepo}`);
  }
  const diffResult = await run(
    'gh',
    ['api', endpoint, '-H', 'Accept: application/vnd.github.v3.diff'],
    repoRoot,
  );
  if (diffResult.exitCode !== 0) throw classifyGithubError(diffResult.stderr);
  const after = await fetchPullRequestMetadata(endpoint, repoRoot, run);
  if (before.baseSha !== after.baseSha || before.headSha !== after.headSha) {
    throw new ReviewTargetError('target_changed', `PR #${pr.number} changed while its diff was being frozen.`);
  }
  return buildFrozenTarget({
    kind: 'pr',
    input,
    repoRoot,
    repoIdentity,
    baseSha: before.baseSha,
    headSha: before.headSha,
    diff: diffResult.stdout,
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
    metadata: {
      prNumber: String(before.number),
      prUrl: before.htmlUrl,
      baseRepo: before.baseRepo,
      headRepo: before.headRepo,
    },
    frozenAt,
  });
}

export async function validateFrozenReviewTarget(
  frozen: FrozenReviewTarget,
  options: FreezeReviewTargetOptions,
): Promise<void> {
  let current: FrozenReviewTarget;
  try {
    current = await freezeReviewTarget(frozen.input, options);
  } catch (error) {
    if (error instanceof ReviewTargetError && error.code === 'target_changed') throw error;
    throw new ReviewTargetError(
      'target_changed',
      `Unable to revalidate frozen review target: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    comparablePath(current.repoRoot) !== comparablePath(frozen.repoRoot) ||
    formatRepoIdentity(current.repoIdentity) !== formatRepoIdentity(frozen.repoIdentity) ||
    current.baseSha !== frozen.baseSha ||
    current.headSha !== frozen.headSha ||
    current.diffHash !== frozen.diffHash
  ) {
    throw new ReviewTargetError('target_changed', 'Review target changed after preflight.');
  }
}

async function resolveRepoRoot(cwd: string, run: ReviewCommandRunner): Promise<string> {
  const result = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new ReviewTargetError('target_not_found', 'Current directory is not inside a Git repository.');
  }
  return resolve(result.stdout.trim());
}

async function resolveHead(repoRoot: string, run: ReviewCommandRunner): Promise<string> {
  const result = await run('git', ['rev-parse', 'HEAD'], repoRoot);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new ReviewTargetError('target_not_found', 'Unable to resolve the current HEAD commit.');
  }
  return result.stdout.trim();
}

async function resolveRepoIdentity(
  repoRoot: string,
  run: ReviewCommandRunner,
): Promise<FrozenReviewTarget['repoIdentity']> {
  const result = await run('git', ['config', '--get', 'remote.origin.url'], repoRoot);
  if (result.exitCode !== 0) return undefined;
  return parseGithubRemote(result.stdout.trim());
}

async function freezeWorktreeDiff(repoRoot: string, headSha: string, run: ReviewCommandRunner): Promise<string> {
  const [tracked, untracked] = await Promise.all([
    requireCommand(
      run('git', ['diff', '--binary', '--no-ext-diff', headSha, '--'], repoRoot),
      'target_not_found',
      'Unable to freeze worktree diff.',
    ),
    requireCommand(
      run('git', ['ls-files', '--others', '--exclude-standard', '-z'], repoRoot),
      'target_not_found',
      'Unable to enumerate untracked files.',
    ),
  ]);
  const snapshots: string[] = [];
  for (const relativePath of untracked.stdout.split('\0').filter(Boolean).sort()) {
    const file = await readSafeFile(repoRoot, resolve(repoRoot, relativePath), MAX_UNTRACKED_FILE_BYTES);
    if (file === undefined) continue;
    if (file.truncated) {
      throw new ReviewTargetError(
        'target_not_found',
        `Untracked file exceeds the ${MAX_UNTRACKED_FILE_BYTES} byte review snapshot limit: ${relativePath}`,
      );
    }
    const content = file.buffer.includes(0) ? file.buffer.toString('base64') : file.buffer.toString('utf8');
    const encoding = file.buffer.includes(0) ? 'base64' : 'utf8';
    snapshots.push(
      `\n<untracked-file path=${JSON.stringify(relativePath)} encoding=${JSON.stringify(encoding)} truncated=${String(file.truncated)}>\n${content}\n</untracked-file>\n`,
    );
  }
  return `${tracked.stdout}${snapshots.join('')}`;
}

function parsePullRequestTarget(
  target: string,
  currentRepo: NonNullable<FrozenReviewTarget['repoIdentity']>,
): { number: number } {
  const trimmed = target.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) return { number: Number.parseInt(trimmed, 10) };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ReviewTargetError('target_not_found', `Invalid pull request target: ${target}`);
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/u.exec(url.pathname);
  if (url.hostname.toLocaleLowerCase() !== 'github.com' || match === null) {
    throw new ReviewTargetError('target_not_found', `Unsupported pull request URL: ${target}`);
  }
  const [, owner, repo, number] = match;
  if (
    owner!.toLocaleLowerCase() !== currentRepo.owner.toLocaleLowerCase() ||
    repo!.replace(/\.git$/iu, '').toLocaleLowerCase() !== currentRepo.repo.toLocaleLowerCase()
  ) {
    throw new ReviewTargetError('repo_mismatch', `Pull request URL does not belong to ${currentRepo.owner}/${currentRepo.repo}.`);
  }
  return { number: Number.parseInt(number!, 10) };
}

async function fetchPullRequestMetadata(
  endpoint: string,
  repoRoot: string,
  run: ReviewCommandRunner,
): Promise<PullRequestMetadata> {
  const result = await run('gh', ['api', endpoint], repoRoot);
  if (result.exitCode !== 0) throw classifyGithubError(result.stderr);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new ReviewTargetError('network_unavailable', 'GitHub returned invalid PR metadata.');
  }
  if (!isRecord(value) || !isRecord(value['base']) || !isRecord(value['head'])) {
    throw new ReviewTargetError('target_not_found', 'GitHub PR metadata is incomplete.');
  }
  const baseRepo = value['base']['repo'];
  const headRepo = value['head']['repo'];
  if (
    !Number.isSafeInteger(value['number']) ||
    typeof value['html_url'] !== 'string' ||
    typeof value['base']['sha'] !== 'string' ||
    !isRecord(baseRepo) ||
    typeof baseRepo['full_name'] !== 'string' ||
    typeof value['head']['sha'] !== 'string' ||
    !isRecord(headRepo) ||
    typeof headRepo['full_name'] !== 'string'
  ) {
    throw new ReviewTargetError('target_not_found', 'GitHub PR metadata is incomplete.');
  }
  return {
    number: value['number'] as number,
    htmlUrl: value['html_url'],
    baseSha: value['base']['sha'],
    headSha: value['head']['sha'],
    baseRepo: baseRepo['full_name'],
    headRepo: headRepo['full_name'],
  };
}

function classifyGithubError(stderr: string): ReviewTargetError {
  const message = stderr.trim() || 'GitHub request failed.';
  if (/not logged|authenticate|authentication|unauthorized|HTTP\s+401|HTTP\s+403.*auth/iu.test(message)) {
    return new ReviewTargetError('auth_required', message);
  }
  if (/rate limit|HTTP\s+429/iu.test(message)) return new ReviewTargetError('rate_limited', message);
  if (/could not resolve|network|connection|timed?\s*out|ENOTFOUND|ECONN/iu.test(message)) {
    return new ReviewTargetError('network_unavailable', message);
  }
  if (/HTTP\s+404|not found/iu.test(message)) return new ReviewTargetError('target_not_found', message);
  return new ReviewTargetError('network_unavailable', message);
}

function parseGithubRemote(remote: string): FrozenReviewTarget['repoIdentity'] {
  const scp = /^(?:[^@]+@)?github\.com:([^/]+)\/(.+)$/iu.exec(remote);
  if (scp !== null) {
    return { host: 'github.com', owner: scp[1]!, repo: scp[2]!.replace(/\.git$/iu, '') };
  }
  try {
    const url = new URL(remote);
    if (url.hostname.toLocaleLowerCase() !== 'github.com') return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
    if (parts.length !== 2) return undefined;
    return { host: 'github.com', owner: parts[0]!, repo: parts[1]!.replace(/\.git$/iu, '') };
  } catch {
    return undefined;
  }
}

function buildFrozenTarget(
  target: Omit<FrozenReviewTarget, 'diffHash'>,
): FrozenReviewTarget {
  return {
    ...target,
    diffHash: createHash('sha256').update(target.diff).digest('hex'),
  };
}

async function requireCommand(
  operation: Promise<ReviewCommandResult>,
  code: ReviewTargetErrorCode,
  message: string,
): Promise<ReviewCommandResult> {
  const result = await operation;
  if (result.exitCode !== 0) throw new ReviewTargetError(code, `${message} ${result.stderr.trim()}`.trim());
  return result;
}

function formatRepoIdentity(identity: FrozenReviewTarget['repoIdentity']): string {
  return identity === undefined ? '' : `${identity.host}/${identity.owner}/${identity.repo}`.toLocaleLowerCase();
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const runReviewCommand: ReviewCommandRunner = (command, args, cwd, options = {}) =>
  new Promise((resolveCommand) => {
    try {
      execFile(
        command,
        args,
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: MAX_COMMAND_OUTPUT,
          timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          const aborted = options.signal?.aborted === true || error?.name === 'AbortError';
          const timedOut = !aborted && error !== null && 'killed' in error && error.killed === true;
          resolveCommand({
            stdout,
            stderr,
            exitCode,
            ...(aborted ? { aborted: true } : {}),
            ...(timedOut ? { timedOut: true } : {}),
          });
        },
      );
    } catch (error) {
      resolveCommand({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        ...(options.signal?.aborted ? { aborted: true } : {}),
      });
    }
  });
