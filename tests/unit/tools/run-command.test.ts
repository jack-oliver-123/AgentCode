import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRunCommandTool } from '../../../src/tools/builtins/run-command.js';
import type { ToolExecutionContext } from '../../../src/tools/types.js';
import { createWorkspace, executeFileTool, readWorkspaceFile, writeWorkspaceFile } from './file-test-helpers.js';

const SENTINEL_SECRET = 'sk-agentcode-e2e-secret-should-not-appear';
const ORIGINAL_BASH_PATH = process.env.AGENTCODE_BASH_PATH;

beforeAll(() => {
  if (process.platform === 'win32' && process.env.AGENTCODE_BASH_PATH === undefined) {
    const gitBashPath = findGitBashOnPath();
    if (gitBashPath !== undefined) {
      process.env.AGENTCODE_BASH_PATH = gitBashPath;
    }
  }
});

afterAll(() => {
  if (ORIGINAL_BASH_PATH === undefined) {
    delete process.env.AGENTCODE_BASH_PATH;
  } else {
    process.env.AGENTCODE_BASH_PATH = ORIGINAL_BASH_PATH;
  }
});

describe('run_command', () => {
  it('runs a successful one-shot command in the workspace', async () => {
    const workspace = await createWorkspace();

    const result = await executeRunCommand(
      JSON.stringify({ command: nodeCommand('process.stdout.write(process.cwd())') }),
      {
        cwd: workspace,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      toolName: 'run_command',
      data: {
        stdout: workspace,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
      },
      meta: {
        timedOut: false,
        truncated: false,
      },
    });
  });

  it('returns non-zero exit codes as observable command results', async () => {
    const workspace = await createWorkspace();
    const command = nodeCommand("process.stdout.write('out'); process.stderr.write('err'); process.exit(7)");

    const result = await executeRunCommand(JSON.stringify({ command }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      toolName: 'run_command',
      data: {
        exitCode: 7,
        stdout: 'out',
        stderr: 'err',
        timedOut: false,
        truncated: false,
      },
      meta: {
        timedOut: false,
        truncated: false,
      },
    });
  });

  it('captures stderr for successful commands', async () => {
    const workspace = await createWorkspace();
    const command = nodeCommand("process.stderr.write('warning')");

    const result = await executeRunCommand(JSON.stringify({ command }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        stdout: '',
        stderr: 'warning',
        exitCode: 0,
      },
    });
  });

  it('terminates commands that exceed the requested timeout', async () => {
    const workspace = await createWorkspace();
    const command = nodeCommand('setTimeout(() => {}, 5000)');

    const result = await executeRunCommand(JSON.stringify({ command, timeoutMs: 50 }), {
      cwd: workspace,
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'command_timeout',
        retryable: true,
      },
      meta: {
        timedOut: true,
      },
    });
  });

  it('returns command timeout details before the executor timeout wins', async () => {
    const workspace = await createWorkspace();
    const command = 'printf before-timeout; sleep 5';

    const result = await executeRunCommand(JSON.stringify({ command }), {
      cwd: workspace,
      timeoutMs: 3000,
    });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'command_timeout',
        details: {
          stdout: 'before-timeout',
        },
      },
      meta: {
        timedOut: true,
      },
    });
  });

  it('truncates stdout and marks successful output as truncated', async () => {
    const workspace = await createWorkspace();
    const command = nodeCommand("process.stdout.write('abcdef')");

    const result = await executeRunCommand(JSON.stringify({ command }), {
      cwd: workspace,
      maxOutputBytes: 4,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        stdout: 'abcd',
        truncated: true,
      },
      meta: {
        truncated: true,
      },
    });
  });

  it('redacts secrets from each output stream before truncating', async () => {
    const workspace = await createWorkspace();
    const command = nodeCommand(`process.stdout.write(${JSON.stringify(`prefix ${SENTINEL_SECRET} suffix`)})`);

    const result = await executeRunCommand(JSON.stringify({ command }), {
      cwd: workspace,
      secrets: [SENTINEL_SECRET],
      maxOutputBytes: 12,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        stdout: 'prefix <reda',
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('sk-agentcode');
    expect(JSON.stringify(result)).not.toContain('should-not-appear');
  });

  it('keeps separate capture windows for stdout and stderr redaction', async () => {
    const workspace = await createWorkspace();
    const command = nodeCommand(
      `process.stdout.write('x'.repeat(1200)); process.stderr.write(${JSON.stringify(`stderr ${SENTINEL_SECRET} suffix`)})`,
    );

    const result = await executeRunCommand(JSON.stringify({ command }), {
      cwd: workspace,
      maxOutputBytes: 24,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        stdout: 'x'.repeat(24),
        stderr: 'stderr sk-<redacted> suf',
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('sk-agentcode');
    expect(JSON.stringify(result)).not.toContain('should-not-appear');
  });

  it('rejects invalid argument shapes before spawning a command', async () => {
    const workspace = await createWorkspace();

    const result = await executeFileTool(createRunCommandTool(), '{"command":"node --version","timeoutMs":0}', {
      cwd: workspace,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments',
      },
    });
  });

  it('rejects background shell jobs before spawning a command', async () => {
    const workspace = await createWorkspace();

    const result = await executeRunCommand(JSON.stringify({ command: 'sleep 5 &' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments',
      },
    });
  });

  it('rejects background shell jobs before comments', async () => {
    const workspace = await createWorkspace();

    const result = await executeRunCommand(JSON.stringify({ command: 'sleep 5&#comment' }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments',
      },
    });
  });

  it('does not read non-interactive bash startup files from BASH_ENV', async () => {
    const workspace = await createWorkspace();
    const originalBashEnv = process.env.BASH_ENV;
    const bashEnvPath = await writeWorkspaceFile(
      workspace,
      'bash-env.sh',
      `echo bash-env-loaded > ${JSON.stringify(join(workspace, 'bash-env-loaded.txt'))}`,
    );

    try {
      process.env.BASH_ENV = bashEnvPath;
      const result = await executeRunCommand(JSON.stringify({ command: 'printf ok' }), { cwd: workspace });

      expect(result).toMatchObject({
        ok: true,
        data: {
          stdout: 'ok',
        },
      });
      await expect(readWorkspaceFile(workspace, 'bash-env-loaded.txt')).rejects.toThrow();
    } finally {
      if (originalBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = originalBashEnv;
      }
    }
  });

  it('returns an actionable error when the configured bash executable is missing', async () => {
    const workspace = await createWorkspace();
    const originalBashPath = process.env.AGENTCODE_BASH_PATH;

    try {
      process.env.AGENTCODE_BASH_PATH = 'agentcode-missing-bash-for-test';
      const result = await executeRunCommand(JSON.stringify({ command: 'printf ok' }), { cwd: workspace });

      expect(result).toMatchObject({
        ok: false,
        toolName: 'run_command',
        error: {
          code: 'command_failed',
          retryable: true,
          details: {
            phase: 'spawn',
            executable: 'agentcode-missing-bash-for-test',
          },
        },
      });
    } finally {
      if (originalBashPath === undefined) {
        delete process.env.AGENTCODE_BASH_PATH;
      } else {
        process.env.AGENTCODE_BASH_PATH = originalBashPath;
      }
    }
  });

  it('reports shell startup failures as command_failed', async () => {
    const workspace = await createWorkspace();
    const invalidCwd = `${workspace}/missing`;

    const result = await executeFileTool(
      createRunCommandTool(),
      JSON.stringify({ command: nodeCommand("process.stdout.write('never')") }),
      {
        cwd: invalidCwd,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'command_failed',
        retryable: true,
        details: {
          phase: 'spawn',
        },
      },
    });
  });
});

function executeRunCommand(argumentsText: string, context: Partial<ToolExecutionContext> & { cwd: string }) {
  return executeFileTool(createRunCommandTool(), argumentsText, {
    timeoutMs: 5000,
    ...context,
  });
}

function nodeCommand(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

function findGitBashOnPath(): string | undefined {
  const pathValue = process.env.Path ?? process.env.PATH;
  if (pathValue === undefined) {
    return undefined;
  }

  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = rawEntry.replace(/^"(.*)"$/, '$1');
    if (entry.length === 0 || !existsSync(join(entry, 'git.exe'))) {
      continue;
    }

    const candidates = [join(entry, 'bash.exe'), join(dirname(entry), 'bin', 'bash.exe')];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (match !== undefined) {
      return match;
    }
  }

  return undefined;
}
