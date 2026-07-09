import { redactToolValue } from '../redaction.js';
import { readFileInputSchema } from '../schemas.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionResult,
  ToolValidationResult,
} from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';
import { isPositiveInteger, truncateUtf8 } from './file-discovery.js';
import { readTextFile } from './text-file.js';
import { invalidArguments, isRecord } from './validation.js';

interface ReadFileInput {
  path: string;
  maxBytes?: number;
}

interface ReadFileOutput {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export function createReadFileTool(): ToolDefinition<ReadFileInput, ReadFileOutput> {
  return {
    name: 'read_file',
    description: 'Read a text file from the current workspace.',
    inputSchema: readFileInputSchema,
    risk: 'read',
    validate: validateReadFileInput,
    execute: executeReadFile,
  };
}

function validateReadFileInput(input: unknown): ToolValidationResult<ReadFileInput> {
  if (!isRecord(input)) {
    return invalidArguments('read_file arguments must be an object.');
  }

  if (typeof input.path !== 'string' || input.path.trim().length === 0) {
    return invalidArguments('read_file.path must be a non-empty string.');
  }

  if (input.maxBytes !== undefined && !isPositiveInteger(input.maxBytes)) {
    return invalidArguments('read_file.maxBytes must be a positive integer when provided.');
  }

  return {
    ok: true,
    value: {
      path: input.path,
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    },
  };
}

async function executeReadFile(
  input: ReadFileInput,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult<ReadFileOutput>> {
  const pathResult = await resolveWorkspacePath(context.cwd, input.path);
  if (!pathResult.ok) {
    return createReadFileError(pathResult.error);
  }

  const fileResult = await readTextFile(pathResult.absolutePath);
  if (!fileResult.ok) {
    return createReadFileError(fileResult.error);
  }

  const redactedContent = redactToolValue(fileResult.file.content, context.secrets);
  const safeContent = typeof redactedContent === 'string' ? redactedContent : fileResult.file.content;
  const maxBytes = getEffectiveMaxBytes(input.maxBytes, context.maxOutputBytes);
  const truncatedContent = truncateUtf8(safeContent, maxBytes);
  const truncated = truncatedContent.bytes < Buffer.byteLength(safeContent, 'utf8');

  return {
    ok: true,
    toolName: 'read_file',
    data: {
      path: pathResult.relativePath,
      content: truncatedContent.content,
      bytes: fileResult.file.bytes,
      truncated,
    },
    meta: {
      durationMs: 0,
      timedOut: false,
      truncated,
    },
  };
}

function createReadFileError(error: ToolExecutionError): ToolExecutionResult<ReadFileOutput> {
  return {
    ok: false,
    toolName: 'read_file',
    error,
    meta: {
      durationMs: 0,
      timedOut: false,
    },
  };
}

function getEffectiveMaxBytes(inputMaxBytes: number | undefined, contextMaxOutputBytes: number): number {
  if (inputMaxBytes === undefined) {
    return contextMaxOutputBytes;
  }

  return Math.min(inputMaxBytes, contextMaxOutputBytes);
}
