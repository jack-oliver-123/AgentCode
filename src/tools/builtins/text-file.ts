import { readFile, stat } from 'node:fs/promises';

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

/** 最大允许读入内存的文件大小（10 MB） */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export async function readTextFile(absolutePath: string): Promise<ReadTextFileResult> {
  // 大文件前置检查：避免将超大文件一次性读入内存导致 OOM
  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_FILE_SIZE_BYTES) {
      return {
        ok: false,
        error: {
          code: 'file_too_large',
          message: `File is ${Math.round(fileStat.size / 1024 / 1024)}MB, exceeding the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit. Use a smaller maxBytes or read specific sections.`,
          retryable: true,
        }
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: createReadFileError(error)
    };
  }

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
