import { editFileInputSchema } from '../schemas.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionResult,
  ToolValidationResult,
} from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';
import { atomicWriteTextFile } from './atomic-write.js';
import { readTextFile } from './text-file.js';
import { invalidArguments, isRecord } from './validation.js';

interface EditFileInput {
  path: string;
  oldText: string;
  newText: string;
}

interface EditFileOutput {
  path: string;
  replacements: number;
  bytes: number;
}

export function createEditFileTool(): ToolDefinition<EditFileInput, EditFileOutput> {
  return {
    name: 'edit_file',
    description: 'Replace text in a workspace file when the original text matches exactly once.',
    inputSchema: editFileInputSchema,
    risk: 'write',
    validate: validateEditFileInput,
    execute: executeEditFile,
  };
}

function validateEditFileInput(input: unknown): ToolValidationResult<EditFileInput> {
  if (!isRecord(input)) {
    return invalidArguments('edit_file arguments must be an object.');
  }

  if (typeof input.path !== 'string' || input.path.trim().length === 0) {
    return invalidArguments('edit_file.path must be a non-empty string.');
  }

  if (typeof input.oldText !== 'string' || input.oldText.length === 0) {
    return invalidArguments('edit_file.oldText must be a non-empty string.');
  }

  if (typeof input.newText !== 'string') {
    return invalidArguments('edit_file.newText must be a string.');
  }

  return {
    ok: true,
    value: {
      path: input.path,
      oldText: input.oldText,
      newText: input.newText,
    },
  };
}

async function executeEditFile(
  input: EditFileInput,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult<EditFileOutput>> {
  const pathResult = await resolveWorkspacePath(context.cwd, input.path);
  if (!pathResult.ok) {
    return createEditFileError(pathResult.error);
  }

  const fileResult = await readTextFile(pathResult.absolutePath);
  if (!fileResult.ok) {
    return createEditFileError(fileResult.error);
  }

  const matchCount = countMatches(fileResult.file.content, input.oldText);
  if (matchCount !== 1) {
    return createEditFileError(createNotUniqueMatchError(matchCount));
  }

  const nextContent = fileResult.file.content.replace(input.oldText, input.newText);
  const writeResult = await atomicWriteTextFile(pathResult.absolutePath, nextContent, {
    overwrite: true,
    operation: 'edit',
  });
  if (!writeResult.ok) {
    return createEditFileError(writeResult.error);
  }

  return {
    ok: true,
    toolName: 'edit_file',
    data: {
      path: pathResult.relativePath,
      replacements: 1,
      bytes: Buffer.byteLength(nextContent, 'utf8'),
    },
    meta: {
      durationMs: 0,
      timedOut: false,
    },
  };
}

function countMatches(content: string, oldText: string): number {
  let count = 0;
  let index = 0;

  while (true) {
    const matchIndex = content.indexOf(oldText, index);
    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    index = matchIndex + oldText.length;
  }
}

function createNotUniqueMatchError(matchCount: number): ToolExecutionError {
  return {
    code: 'not_unique_match',
    message: `Expected exactly one match for oldText, found ${matchCount}.`,
    retryable: true,
    details: {
      matches: matchCount,
    },
  };
}

function createEditFileError(error: ToolExecutionError): ToolExecutionResult<EditFileOutput> {
  return {
    ok: false,
    toolName: 'edit_file',
    error,
    meta: {
      durationMs: 0,
      timedOut: false,
    },
  };
}
