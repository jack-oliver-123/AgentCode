import { link, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ToolExecutionError } from '../types.js';
import { createInvalidArgumentsError } from './validation.js';

export type AtomicWriteTextResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: ToolExecutionError;
    };

interface AtomicWriteTextOptions {
  overwrite: boolean;
  operation: 'write' | 'edit';
}

export async function atomicWriteTextFile(
  absolutePath: string,
  content: string,
  options: AtomicWriteTextOptions
): Promise<AtomicWriteTextResult> {
  const tempPath = createTempPath(absolutePath);

  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });

    if (options.overwrite) {
      await rename(tempPath, absolutePath);
    } else {
      await link(tempPath, absolutePath);
      await removeTemporaryFile(tempPath);
    }

    return { ok: true };
  } catch (error) {
    await removeTemporaryFile(tempPath);
    return {
      ok: false,
      error: createAtomicWriteError(error, options.operation)
    };
  }
}

async function removeTemporaryFile(tempPath: string): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch {
    // The target write may already be committed; cleanup failure must not flip the result.
  }
}

function createTempPath(absolutePath: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return join(dirname(absolutePath), `.${basename(absolutePath)}.${suffix}.tmp`);
}

function createAtomicWriteError(error: unknown, operation: AtomicWriteTextOptions['operation']): ToolExecutionError {
  if (isNodeError(error) && error.code === 'EEXIST') {
    return createInvalidArgumentsError('File already exists. Set overwrite to true to replace it.');
  }

  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return {
      code: 'permission_denied',
      message: `Permission denied while ${operation === 'edit' ? 'editing' : 'writing'} file.`,
      retryable: true
    };
  }

  if (isNodeError(error) && error.code === 'EISDIR') {
    return {
      code: 'file_not_text',
      message: 'Path points to a directory, not a text file.',
      retryable: true
    };
  }

  return {
    code: 'tool_internal_error',
    message: error instanceof Error ? error.message : `Failed to ${operation === 'edit' ? 'edit' : 'write'} file.`,
    retryable: false
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
