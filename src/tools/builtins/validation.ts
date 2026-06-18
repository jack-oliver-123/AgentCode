import type { ToolExecutionError, ToolValidationResult } from '../types.js';

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function invalidArguments<TInput>(message: string): ToolValidationResult<TInput> {
  return {
    ok: false,
    error: createInvalidArgumentsError(message)
  };
}

export function createInvalidArgumentsError(message: string): ToolExecutionError {
  return {
    code: 'invalid_arguments',
    message,
    retryable: true
  };
}
