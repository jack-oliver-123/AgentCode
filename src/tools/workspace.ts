import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { ToolExecutionError } from './types.js';

export type WorkspacePathResult =
  | {
      ok: true;
      absolutePath: string;
      relativePath: string;
    }
  | {
      ok: false;
      error: ToolExecutionError;
    };

export async function resolveWorkspacePath(cwd: string, inputPath: string): Promise<WorkspacePathResult> {
  if (inputPath.trim().length === 0) {
    return createWorkspacePathError('invalid_arguments', 'Tool path must not be empty.', true);
  }

  const workspaceRoot = await realpath(cwd);
  const workspaceDisplayRoot = resolve(cwd);
  const candidatePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspaceDisplayRoot, inputPath);
  if (!isPathInside(workspaceDisplayRoot, candidatePath) && !isPathInside(workspaceRoot, candidatePath)) {
    return createWorkspacePathError('path_outside_workspace', 'Tool path must stay inside the workspace.', true);
  }

  const realPathResult = await resolveRealCandidatePath(candidatePath);

  if (!realPathResult.ok) {
    return realPathResult.error;
  }

  if (!isPathInside(workspaceRoot, realPathResult.realCandidatePath)) {
    return createWorkspacePathError('path_outside_workspace', 'Tool path resolves outside the workspace.', true);
  }

  return {
    ok: true,
    absolutePath: resolve(workspaceRoot, relative(workspaceRoot, realPathResult.realCandidatePath)),
    relativePath: relative(workspaceRoot, realPathResult.realCandidatePath),
  };
}

type RealCandidatePathResult =
  | {
      ok: true;
      realCandidatePath: string;
    }
  | {
      ok: false;
      error: WorkspacePathResult;
    };

async function resolveRealCandidatePath(candidatePath: string): Promise<RealCandidatePathResult> {
  const nearestExistingPath = await findNearestExistingPath(candidatePath);
  if (nearestExistingPath === undefined) {
    return {
      ok: false,
      error: createWorkspacePathError('file_not_found', 'Tool path parent directory does not exist.', true),
    };
  }

  const realNearestPath = await safeRealpath(nearestExistingPath);
  if (realNearestPath === undefined) {
    return {
      ok: false,
      error: createWorkspacePathError(
        'path_outside_workspace',
        'Tool path resolves through a broken symbolic link.',
        true,
      ),
    };
  }

  return {
    ok: true,
    realCandidatePath: resolve(realNearestPath, relative(nearestExistingPath, candidatePath)),
  };
}

async function findNearestExistingPath(path: string): Promise<string | undefined> {
  let currentPath = path;

  while (true) {
    if (await pathExistsWithoutFollowingSymlink(currentPath)) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }

    currentPath = parentPath;
  }
}

async function pathExistsWithoutFollowingSymlink(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedTarget = normalizeForComparison(target);
  const pathToTarget = relative(normalizedRoot, normalizedTarget);

  return pathToTarget === '' || (!pathToTarget.startsWith('..') && !isAbsolute(pathToTarget));
}

function normalizeForComparison(path: string): string {
  const resolvedPath = resolve(path);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function createWorkspacePathError(
  code: ToolExecutionError['code'],
  message: string,
  retryable: boolean,
): WorkspacePathResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
  };
}
