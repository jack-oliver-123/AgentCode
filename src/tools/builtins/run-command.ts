import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { redactToolValue } from '../redaction.js';
import { runCommandInputSchema } from '../schemas.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionResult,
  ToolValidationResult,
} from '../types.js';
import { isPositiveInteger, truncateUtf8 } from './file-discovery.js';
import { invalidArguments, isRecord } from './validation.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_OVERSCAN_BYTES = 1024;
const EXECUTOR_TIMEOUT_GUARD_MS = 400;
const TIMEOUT_RESULT_GRACE_MS = 150;

interface RunCommandInput {
  command: string;
  timeoutMs?: number;
}

interface RunCommandOutput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface BashShellCommand {
  executable: string;
  args: string[];
}

export function createRunCommandTool(): ToolDefinition<RunCommandInput, RunCommandOutput> {
  return {
    name: 'run_command',
    description: 'Run a one-shot non-interactive command in the current workspace.',
    inputSchema: runCommandInputSchema,
    risk: 'execute',
    validate: validateRunCommandInput,
    execute: executeRunCommand,
  };
}

function validateRunCommandInput(input: unknown): ToolValidationResult<RunCommandInput> {
  if (!isRecord(input)) {
    return invalidArguments('run_command arguments must be an object.');
  }

  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    return invalidArguments('run_command.command must be a non-empty string.');
  }

  if (input.timeoutMs !== undefined && !isPositiveInteger(input.timeoutMs)) {
    return invalidArguments('run_command.timeoutMs must be a positive integer when provided.');
  }

  if (containsBackgroundOperator(input.command)) {
    return invalidArguments('run_command.command must not start background jobs with &.');
  }

  return {
    ok: true,
    value: {
      command: input.command,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    },
  };
}

async function executeRunCommand(
  input: RunCommandInput,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult<RunCommandOutput>> {
  return new Promise<ToolExecutionResult<RunCommandOutput>>((resolve) => {
    const capture = new OutputCapture(getCaptureByteLimit(context));
    const timeoutMs = getEffectiveTimeoutMs(input.timeoutMs, context.timeoutMs);
    let settled = false;
    let timedOut = false;
    // biome-ignore lint/style/useConst: assigned in deferred setTimeout callback
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let killEscalationId: ReturnType<typeof setTimeout> | undefined;
    let timeoutResultId: ReturnType<typeof setTimeout> | undefined;

    const shell = createBashShellCommand(input.command);
    const child = spawn(shell.executable, shell.args, {
      cwd: context.cwd,
      env: createSanitizedEnvironment(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const settle = (result: ToolExecutionResult<RunCommandOutput>): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (killEscalationId !== undefined) {
        clearTimeout(killEscalationId);
      }
      if (timeoutResultId !== undefined) {
        clearTimeout(timeoutResultId);
      }
      context.signal?.removeEventListener('abort', abortListener);
      resolve(result);
    };

    const abortListener = (): void => {
      killEscalationId = terminateCommand(child);
    };

    child.stdout.on('data', (chunk: Buffer) => capture.appendStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => capture.appendStderr(chunk));

    child.on('error', (error) => {
      settle(createRunCommandError(input.command, createSpawnError(error, shell.executable), capture.prepare(context)));
    });

    child.on('close', (exitCode, signal) => {
      const output = capture.prepare(context);
      if (timedOut) {
        settle(createRunCommandError(input.command, createTimeoutError(timeoutMs, output), output, true));
        return;
      }

      settle(createRunCommandSuccess(input.command, exitCode, output));
    });

    context.signal?.addEventListener('abort', abortListener, { once: true });
    timeoutId = setTimeout(() => {
      timedOut = true;
      killEscalationId = terminateCommand(child);
      timeoutResultId = setTimeout(() => {
        const output = capture.prepare(context);
        settle(createRunCommandError(input.command, createTimeoutError(timeoutMs, output), output, true));
      }, TIMEOUT_RESULT_GRACE_MS);
    }, timeoutMs);
  });
}

class OutputCapture {
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private truncated = false;

  constructor(private readonly byteLimitPerStream: number) {}

  appendStdout(chunk: Buffer): void {
    this.stdoutBytes = this.append(chunk, this.stdoutChunks, this.stdoutBytes);
  }

  appendStderr(chunk: Buffer): void {
    this.stderrBytes = this.append(chunk, this.stderrChunks, this.stderrBytes);
  }

  prepare(context: ToolExecutionContext): CommandOutput {
    const stdout = redactAndTruncate(Buffer.concat(this.stdoutChunks).toString('utf8'), context);
    const stderr = redactAndTruncate(Buffer.concat(this.stderrChunks).toString('utf8'), context);

    return {
      stdout: stdout.content,
      stderr: stderr.content,
      truncated: this.truncated || stdout.truncated || stderr.truncated,
    };
  }

  private append(chunk: Buffer, target: Buffer[], capturedBytes: number): number {
    const remainingBytes = this.byteLimitPerStream - capturedBytes;
    if (remainingBytes <= 0) {
      this.truncated = true;
      return capturedBytes;
    }

    if (chunk.byteLength <= remainingBytes) {
      target.push(chunk);
      return capturedBytes + chunk.byteLength;
    }

    target.push(chunk.subarray(0, remainingBytes));
    this.truncated = true;
    return this.byteLimitPerStream;
  }
}

function redactAndTruncate(content: string, context: ToolExecutionContext): { content: string; truncated: boolean } {
  const redactedContent = redactToolValue(content, context.secrets);
  const safeContent = typeof redactedContent === 'string' ? redactedContent : content;
  const truncatedContent = truncateUtf8(safeContent, Math.max(0, context.maxOutputBytes));

  return {
    content: truncatedContent.content,
    truncated: truncatedContent.bytes < Buffer.byteLength(safeContent, 'utf8'),
  };
}

function getCaptureByteLimit(context: ToolExecutionContext): number {
  const longestSecretBytes = context.secrets.reduce(
    (maxBytes, secret) => Math.max(maxBytes, Buffer.byteLength(secret, 'utf8')),
    0,
  );
  return Math.max(0, context.maxOutputBytes + longestSecretBytes + OUTPUT_OVERSCAN_BYTES);
}

function createSanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowedNames = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'SystemDrive'];
  return Object.fromEntries(
    allowedNames.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

function createBashShellCommand(command: string): BashShellCommand {
  return {
    executable: process.env.AGENTCODE_BASH_PATH ?? 'bash',
    args: ['--noprofile', '--norc', '-c', command],
  };
}

function containsBackgroundOperator(command: string): boolean {
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }

    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }

    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }

    if (quote !== undefined || char !== '&') {
      continue;
    }

    const previousChar = command[index - 1];
    const nextChar = command[index + 1];
    if (
      previousChar === '&' ||
      nextChar === '&' ||
      previousChar === '>' ||
      nextChar === '>' ||
      previousChar === '|' ||
      previousChar === ';'
    ) {
      continue;
    }

    return true;
  }

  return false;
}

function getEffectiveTimeoutMs(inputTimeoutMs: number | undefined, contextTimeoutMs: number): number {
  const guardedContextTimeoutMs = Math.max(1, contextTimeoutMs - EXECUTOR_TIMEOUT_GUARD_MS);
  return Math.min(inputTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, guardedContextTimeoutMs, MAX_COMMAND_TIMEOUT_MS);
}

function terminateCommand(
  child: ChildProcessByStdio<null, Readable, Readable>,
): ReturnType<typeof setTimeout> | undefined {
  if (child.pid === undefined) {
    return undefined;
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
    return undefined;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }

  return setTimeout(() => forceKillCommand(child), 100);
}

function forceKillCommand(child: ChildProcessByStdio<null, Readable, Readable>): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function createRunCommandSuccess(
  command: string,
  exitCode: number | null,
  output: CommandOutput,
): ToolExecutionResult<RunCommandOutput> {
  return {
    ok: true,
    toolName: 'run_command',
    data: {
      command,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode,
      timedOut: false,
      truncated: output.truncated,
    },
    meta: {
      durationMs: 0,
      timedOut: false,
      truncated: output.truncated,
    },
  };
}

function createRunCommandError(
  command: string,
  error: ToolExecutionError,
  output: CommandOutput,
  timedOut = false,
): ToolExecutionResult<RunCommandOutput> {
  return {
    ok: false,
    toolName: 'run_command',
    error,
    meta: {
      durationMs: 0,
      timedOut,
      truncated: output.truncated,
    },
  };
}

function createSpawnError(error: Error, executable: string): ToolExecutionError {
  return {
    code: 'command_failed',
    message: `Failed to start bash shell (${executable}): ${error.message}`,
    retryable: true,
    details: {
      phase: 'spawn',
      executable,
    },
  };
}

function createExitError(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  output: CommandOutput,
): ToolExecutionError {
  return {
    code: 'command_failed',
    message: `Command exited with ${exitCode === null ? `signal ${signal ?? 'unknown'}` : `exit code ${exitCode}`}.`,
    retryable: true,
    details: {
      exitCode,
      signal,
      stdout: output.stdout,
      stderr: output.stderr,
      truncated: output.truncated,
    },
  };
}

function createTimeoutError(timeoutMs: number, output: CommandOutput): ToolExecutionError {
  return {
    code: 'command_timeout',
    message: `Command timed out after ${timeoutMs}ms.`,
    retryable: true,
    details: {
      stdout: output.stdout,
      stderr: output.stderr,
      truncated: output.truncated,
    },
  };
}
