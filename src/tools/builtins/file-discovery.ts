import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { ToolExecutionError } from '../types.js';

const DEFAULT_EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', 'dist']);

export interface WorkspaceFileEntry {
  absolutePath: string;
  relativePath: string;
}

export type WorkspaceFileListResult =
  | {
      ok: true;
      files: WorkspaceFileEntry[];
    }
  | {
      ok: false;
      error: ToolExecutionError;
    };

export type WorkspaceFileVisitResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: ToolExecutionError;
    };

export interface GlobMatcher {
  matches(path: string): boolean;
}

export type GlobMatcherResult =
  | {
      ok: true;
      matcher: GlobMatcher;
    }
  | {
      ok: false;
      message: string;
    };

export async function listWorkspaceFiles(cwd: string): Promise<WorkspaceFileListResult> {
  const files: WorkspaceFileEntry[] = [];
  const visitResult = await visitWorkspaceFiles(cwd, (file) => {
    files.push(file);
    return true;
  });

  if (!visitResult.ok) {
    return visitResult;
  }

  return {
    ok: true,
    files,
  };
}

export async function visitWorkspaceFiles(
  cwd: string,
  onFile: (file: WorkspaceFileEntry) => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<WorkspaceFileVisitResult> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(cwd);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'tool_internal_error',
        message: error instanceof Error ? error.message : 'Failed to resolve workspace root.',
        retryable: false,
      },
    };
  }

  try {
    await visitWorkspaceDirectory(workspaceRoot, workspaceRoot, onFile, signal);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'tool_internal_error',
        message: error instanceof Error ? error.message : 'Failed to list workspace files.',
        retryable: false,
      },
    };
  }
}

export function createGlobMatcher(pattern: string): GlobMatcherResult {
  const normalizedPattern = normalizeGlobPattern(pattern);
  if (normalizedPattern === undefined) {
    return {
      ok: false,
      message: 'Glob pattern must be a non-empty workspace-relative pattern.',
    };
  }

  if (isUnsafeGlobPattern(normalizedPattern)) {
    return {
      ok: false,
      message: 'Glob pattern must stay inside the workspace.',
    };
  }

  const regex = globPatternToRegex(normalizedPattern);
  return {
    ok: true,
    matcher: {
      matches: (path: string) => regex.test(path),
    },
  };
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function truncateUtf8(content: string, maxBytes: number): { content: string; bytes: number } {
  let bytes = 0;
  let truncatedContent = '';

  for (const char of content) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }

    bytes += charBytes;
    truncatedContent += char;
  }

  return {
    content: truncatedContent,
    bytes,
  };
}

async function visitWorkspaceDirectory(
  root: string,
  directory: string,
  onFile: (file: WorkspaceFileEntry) => boolean | Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (signal?.aborted) {
      return false;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }

      if (!(await visitWorkspaceDirectory(root, absolutePath, onFile, signal))) {
        return false;
      }
      continue;
    }

    if (entry.isFile()) {
      const shouldContinue = await onFile({
        absolutePath,
        relativePath: toWorkspaceRelativePath(root, absolutePath),
      });
      if (!shouldContinue) {
        return false;
      }
    }
  }

  return true;
}

function toWorkspaceRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split('\\').join('/');
}

function normalizeGlobPattern(pattern: string): string | undefined {
  const normalizedPattern = pattern
    .trim()
    .split('\\')
    .join('/')
    .replace(/^\.\/+/, '');
  return normalizedPattern.length === 0 ? undefined : normalizedPattern;
}

function isUnsafeGlobPattern(pattern: string): boolean {
  return isAbsolute(pattern) || /^[A-Za-z]:\//.test(pattern) || pattern.split('/').includes('..');
}

function globPatternToRegex(pattern: string): RegExp {
  let source = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const charAfterGlobstar = pattern[index + 2];
        if (charAfterGlobstar === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegexCharacter(char);
  }

  return new RegExp(`${source}$`);
}

function escapeRegexCharacter(char: string | undefined): string {
  if (char === undefined) {
    return '';
  }

  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}
