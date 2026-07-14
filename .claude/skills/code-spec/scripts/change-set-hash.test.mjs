import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./change-set-hash.mjs', import.meta.url));

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function runHasher(cwd, ...paths) {
  return JSON.parse(run(process.execPath, [scriptPath, '--', ...paths], cwd));
}

function createRepository() {
  const directory = mkdtempSync(path.join(tmpdir(), 'code-spec-hash-'));
  run('git', ['init', '--quiet'], directory);
  run('git', ['config', 'user.email', 'test@example.invalid'], directory);
  run('git', ['config', 'user.name', 'Skill Test'], directory);
  writeFileSync(path.join(directory, 'tracked.txt'), 'one\n', 'utf8');
  run('git', ['add', 'tracked.txt'], directory);
  run('git', ['commit', '--quiet', '-m', 'initial'], directory);
  return directory;
}

test('change_set_hash is stable and tracks scoped content', () => {
  const directory = createRepository();

  try {
    const first = runHasher(directory, 'tracked.txt');
    const second = runHasher(directory, 'tracked.txt');
    assert.equal(first.change_set_hash, second.change_set_hash);

    writeFileSync(path.join(directory, 'tracked.txt'), 'two\n', 'utf8');
    const trackedChange = runHasher(directory, 'tracked.txt');
    assert.notEqual(trackedChange.change_set_hash, first.change_set_hash);

    writeFileSync(path.join(directory, 'untracked.txt'), 'alpha\n', 'utf8');
    const untrackedFirst = runHasher(directory, 'untracked.txt');
    writeFileSync(path.join(directory, 'untracked.txt'), 'beta\n', 'utf8');
    const untrackedSecond = runHasher(directory, 'untracked.txt');
    assert.notEqual(untrackedSecond.change_set_hash, untrackedFirst.change_set_hash);
    assert.equal(untrackedSecond.untracked[0].path, 'untracked.txt');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('change_set_hash rejects paths outside the repository', () => {
  const directory = createRepository();
  const outside = mkdtempSync(path.join(tmpdir(), 'code-spec-outside-'));

  try {
    assert.throws(
      () => run(process.execPath, [scriptPath, '--', outside], directory),
      /Path must resolve to a file or directory inside the repository/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
