import { globFilesInputSchema } from '../schemas.js';
import type { ToolDefinition, ToolExecutionContext, ToolExecutionError, ToolExecutionResult, ToolValidationResult } from '../types.js';
import { createGlobMatcher, isPositiveInteger, visitWorkspaceFiles } from './file-discovery.js';
import { invalidArguments, isRecord } from './validation.js';

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS_LIMIT = 500;

interface GlobFilesInput {
  pattern: string;
  maxResults?: number;
}

interface GlobFilesOutput {
  matches: string[];
  truncated: boolean;
}

export function createGlobFilesTool(): ToolDefinition<GlobFilesInput, GlobFilesOutput> {
  return {
    name: 'glob_files',
    description: 'Find workspace files matching a controlled glob pattern.',
    inputSchema: globFilesInputSchema,
    risk: 'read',
    validate: validateGlobFilesInput,
    execute: executeGlobFiles
  };
}

function validateGlobFilesInput(input: unknown): ToolValidationResult<GlobFilesInput> {
  if (!isRecord(input)) {
    return invalidArguments('glob_files arguments must be an object.');
  }

  if (typeof input.pattern !== 'string' || input.pattern.trim().length === 0) {
    return invalidArguments('glob_files.pattern must be a non-empty string.');
  }

  if (input.maxResults !== undefined && !isPositiveInteger(input.maxResults)) {
    return invalidArguments('glob_files.maxResults must be a positive integer when provided.');
  }

  return {
    ok: true,
    value: {
      pattern: input.pattern,
      ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {})
    }
  };
}

async function executeGlobFiles(input: GlobFilesInput, context: ToolExecutionContext): Promise<ToolExecutionResult<GlobFilesOutput>> {
  const matcherResult = createGlobMatcher(input.pattern);
  if (!matcherResult.ok) {
    return createGlobFilesError({
      code: 'invalid_arguments',
      message: matcherResult.message,
      retryable: true
    });
  }

  const maxResults = getEffectiveMaxResults(input.maxResults);
  const matches: string[] = [];
  let truncated = false;
  const visitResult = await visitWorkspaceFiles(context.cwd, (file) => {
    if (!matcherResult.matcher.matches(file.relativePath)) {
      return true;
    }

    matches.push(file.relativePath);
    if (matches.length > maxResults) {
      truncated = true;
      return false;
    }

    return true;
  }, context.signal);
  if (!visitResult.ok) {
    return createGlobFilesError(visitResult.error);
  }

  return {
    ok: true,
    toolName: 'glob_files',
    data: {
      matches: matches.slice(0, maxResults),
      truncated
    },
    meta: {
      durationMs: 0,
      timedOut: false,
      truncated
    }
  };
}

function getEffectiveMaxResults(inputMaxResults: number | undefined): number {
  return Math.min(inputMaxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT);
}

function createGlobFilesError(error: ToolExecutionError): ToolExecutionResult<GlobFilesOutput> {
  return {
    ok: false,
    toolName: 'glob_files',
    error,
    meta: {
      durationMs: 0,
      timedOut: false
    }
  };
}
