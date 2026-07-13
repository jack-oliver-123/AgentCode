#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_BUFFER = 512 * 1024 * 1024;

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });

  if (result.status !== 0) {
    const message = result.stderr?.toString('utf8').trim() || 'git command failed';
    throw new Error(`${message} (${args.join(' ')})`);
  }

  return result.stdout;
}

function parsePathspecs(repoRoot) {
  const separator = process.argv.indexOf('--');
  const inputs = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);

  if (inputs.length === 0) {
    throw new Error('Provide at least one task path after --');
  }

  return inputs
    .map((input) => {
      if (input.includes('\0')) throw new Error('Path contains a NUL byte');
      const absolute = path.resolve(repoRoot, input);
      const relative = path.relative(repoRoot, absolute);
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path must resolve to a file or directory inside the repository: ${input}`);
      }
      return relative.split(path.sep).join('/');
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function splitNul(buffer) {
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) values.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) values.push(buffer.subarray(start));
  return values;
}

function fileType(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  throw new Error('Only regular files and symbolic links may be hashed as untracked inputs');
}

function contentForUntracked(absolute, stat) {
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(absolute), 'utf8');
  return readFileSync(absolute);
}

function addField(hash, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  hash.update(Buffer.from(`${name}\0${bytes.length}\0`, 'utf8'));
  hash.update(bytes);
  hash.update(Buffer.from('\0', 'utf8'));
}

try {
  const repoRoot = runGit(['rev-parse', '--show-toplevel'], process.cwd()).toString('utf8').trim();
  const pathspecs = parsePathspecs(repoRoot);
  const literalPathspecs = pathspecs.map((pathspec) => `:(literal)${pathspec}`);
  const head = runGit(['rev-parse', '--verify', 'HEAD'], repoRoot).toString('ascii').trim();
  const status = runGit(
    [
      '-c',
      'status.renames=false',
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--',
      ...literalPathspecs,
    ],
    repoRoot,
  );
  const trackedDiff = runGit(
    [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      'HEAD',
      '--',
      ...literalPathspecs,
    ],
    repoRoot,
  );
  const untrackedPaths = splitNul(
    runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', ...literalPathspecs], repoRoot),
  ).sort(Buffer.compare);

  const hash = createHash('sha256');
  addField(hash, 'schema', 'code-spec-change-set-v1');
  addField(hash, 'head', head);
  for (const pathspec of pathspecs) addField(hash, 'pathspec', pathspec);
  addField(hash, 'status-porcelain-v2', status);
  addField(hash, 'tracked-binary-diff', trackedDiff);

  const untracked = [];
  for (const rawPath of untrackedPaths) {
    const relative = rawPath.toString('utf8');
    const absolute = path.resolve(repoRoot, relative);
    const stat = lstatSync(absolute);
    const type = fileType(stat);
    const content = contentForUntracked(absolute, stat);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const mode = (stat.mode & 0o7777).toString(8);

    addField(hash, 'untracked-path', rawPath);
    addField(hash, 'untracked-type', type);
    addField(hash, 'untracked-mode', mode);
    addField(hash, 'untracked-content', content);
    untracked.push({ path: relative, type, mode, sha256: contentHash });
  }

  process.stdout.write(
    `${JSON.stringify({
      schema: 'code-spec-change-set-v1',
      head,
      pathspecs,
      change_set_hash: hash.digest('hex'),
      tracked_diff_bytes: trackedDiff.length,
      untracked,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`change-set-hash: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
