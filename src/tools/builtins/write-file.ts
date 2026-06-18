import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { writeFileInputSchema } from '../schemas.js';
import type { ToolDefinition, ToolExecutionContext, ToolExecutionError, ToolExecutionResult, ToolValidationResult } from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';
import { atomicWriteTextFile } from './atomic-write.js';
import { createInvalidArgumentsError, invalidArguments, isRecord } from './validation.js';

interface WriteFileInput {
  path: string;
  content: string;
  overwrite?: boolean;
}

interface WriteFileOutput {
  path: string;
  bytes: number;
  overwritten: boolean;
}

export function createWriteFileTool(): ToolDefinition<WriteFileInput, WriteFileOutput> {
  return {
    name: 'write_file',
    description: 'Write text content to a file in the current workspace.',
    inputSchema: writeFileInputSchema,
    risk: 'write',
    validate: validateWriteFileInput,
    execute: executeWriteFile
  };
}

function validateWriteFileInput(input: unknown): ToolValidationResult<WriteFileInput> {
  if (!isRecord(input)) {
    return invalidArguments('write_file arguments must be an object.');
  }

  if (typeof input.path !== 'string' || input.path.trim().length === 0) {
    return invalidArguments('write_file.path must be a non-empty string.');
  }

  if (typeof input.content !== 'string') {
    return invalidArguments('write_file.content must be a string.');
  }

  if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') {
    return invalidArguments('write_file.overwrite must be a boolean when provided.');
  }

  return {
    ok: true,
    value: {
      path: input.path,
      content: input.content,
      ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {})
    }
  };
}

async function executeWriteFile(input: WriteFileInput, context: ToolExecutionContext): Promise<ToolExecutionResult<WriteFileOutput>> {
  const pathResult = await resolveWorkspacePath(context.cwd, input.path);
  if (!pathResult.ok) {
    return createWriteFileError(pathResult.error);
  }

  const overwritten = input.overwrite === true;

  const parentDirectoryResult = await ensureParentDirectory(pathResult.absolutePath);
  if (!parentDirectoryResult.ok) {
    return createWriteFileError(parentDirectoryResult.error);
  }

  const writeResult = await atomicWriteTextFile(pathResult.absolutePath, input.content, {
    overwrite: overwritten,
    operation: 'write'
  });
  if (!writeResult.ok) {
    return createWriteFileError(writeResult.error);
  }

  return {
    ok: true,
    toolName: 'write_file',
    data: {
      path: pathResult.relativePath,
      bytes: Buffer.byteLength(input.content, 'utf8'),
      overwritten
    },
    meta: {
      durationMs: 0,
      timedOut: false
    }
  };
}

async function ensureParentDirectory(absolutePath: string): Promise<{ ok: true } | { ok: false; error: ToolExecutionError }> {
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: createParentDirectoryError(error)
    };
  }
}

function createParentDirectoryError(error: unknown): ToolExecutionError {
  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return {
      code: 'permission_denied',
      message: 'Permission denied while creating parent directory for write_file.',
      retryable: true
    };
  }

  if (isNodeError(error) && (error.code === 'ENOTDIR' || error.code === 'EEXIST')) {
    return createInvalidArgumentsError('write_file parent path is not a directory.');
  }

  return {
    code: 'tool_internal_error',
    message: error instanceof Error ? error.message : 'Failed to create parent directory for write_file.',
    retryable: false
  };
}

function createWriteFileError(error: ToolExecutionError): ToolExecutionResult<WriteFileOutput> {
  return {
    ok: false,
    toolName: 'write_file',
    error,
    meta: {
      durationMs: 0,
      timedOut: false
    }
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
