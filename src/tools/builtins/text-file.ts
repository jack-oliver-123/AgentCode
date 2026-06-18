import { readFile } from 'node:fs/promises';

import type { ToolExecutionError } from '../types.js';

export interface TextFileContent {
  content: string;
  bytes: number;
}

export type ReadTextFileResult =
  | {
      ok: true;
      file: TextFileContent;
    }
  | {
      ok: false;
      error: ToolExecutionError;
    };

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

export async function readTextFile(absolutePath: string): Promise<ReadTextFileResult> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(absolutePath);
  } catch (error) {
    return {
      ok: false,
      error: createReadFileError(error)
    };
  }

  if (fileBuffer.includes(0)) {
    return {
      ok: false,
      error: createFileNotTextError()
    };
  }

  try {
    return {
      ok: true,
      file: {
        content: TEXT_DECODER.decode(fileBuffer),
        bytes: fileBuffer.byteLength
      }
    };
  } catch {
    return {
      ok: false,
      error: createFileNotTextError()
    };
  }
}

function createReadFileError(error: unknown): ToolExecutionError {
  if (isNodeError(error) && error.code === 'ENOENT') {
    return {
      code: 'file_not_found',
      message: 'File does not exist.',
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

  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return {
      code: 'permission_denied',
      message: 'Permission denied while reading file.',
      retryable: true
    };
  }

  return {
    code: 'tool_internal_error',
    message: error instanceof Error ? error.message : 'Failed to read file.',
    retryable: false
  };
}

function createFileNotTextError(): ToolExecutionError {
  return {
    code: 'file_not_text',
    message: 'File is not valid UTF-8 text.',
    retryable: true
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
