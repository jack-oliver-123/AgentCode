import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const script = 'tests/e2e/tmux/agentcode-smoke.sh';
const bash = resolveBash();

if (bash === undefined) {
  process.stderr.write('E2E smoke blocked: Git Bash was not found on Windows. Set AGENTCODE_BASH_PATH.\n');
  process.exitCode = 2;
} else {
  const child = spawn(bash, [script], { stdio: 'inherit', env: process.env });
  child.on('error', (error) => {
    process.stderr.write(`E2E smoke failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128);
  });
}

function resolveBash() {
  if (process.platform !== 'win32') return 'bash';

  const candidates = [process.env['AGENTCODE_BASH_PATH']];
  try {
    const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const gitRoot = dirname(dirname(dirname(resolve(gitExecPath))));
    candidates.push(join(gitRoot, 'bin', 'bash.exe'));
  } catch {
    // Fall through to common install locations and PATH discovery.
  }
  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Develop\\Git\\bin\\bash.exe',
  );
  try {
    const discovered = execFileSync('where.exe', ['bash.exe'], { encoding: 'utf8' })
      .split(/\r?\n/u)
      .filter((path) => /[\\/]Git[\\/]/iu.test(path));
    candidates.push(...discovered);
  } catch {
    // No PATH candidate is acceptable.
  }

  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
