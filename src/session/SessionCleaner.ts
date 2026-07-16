import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWritePrivateFile, findSafeDirectory, readSafeFile } from '../shared/safeFs.js';

const CLEAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FILE_MODE = 0o600;

export interface SessionCleanerOptions {
  now?: () => number;
}

export async function maybeClean(cwd: string, options: SessionCleanerOptions = {}): Promise<void> {
  const now = options.now?.() ?? Date.now();
  const agentcodeDir = join(cwd, '.agentcode');
  const lastCleanupPath = join(agentcodeDir, 'last_cleanup');

  try {
    if (!(await cleanupIsDue(cwd, lastCleanupPath, now))) {
      return;
    }

    await cleanOldSessions(cwd, join(agentcodeDir, 'sessions'), now);
    await atomicWritePrivateFile(cwd, lastCleanupPath, new Date(now).toISOString(), FILE_MODE);
  } catch (error) {
    console.warn('[SessionCleaner] 会话清理失败', error);
  }
}

async function cleanupIsDue(cwd: string, lastCleanupPath: string, now: number): Promise<boolean> {
  try {
    const result = await readSafeFile(cwd, lastCleanupPath, 1024);
    if (result === undefined || result.truncated) return true;
    const timestamp = Date.parse(result.buffer.toString('utf8').trim());
    return !Number.isFinite(timestamp) || now - timestamp > CLEAN_INTERVAL_MS;
  } catch {
    return true;
  }
}

async function cleanOldSessions(cwd: string, sessionsDir: string, now: number): Promise<void> {
  const safeSessionsDir = await findSafeDirectory(cwd, sessionsDir);
  if (safeSessionsDir === undefined) return;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(safeSessionsDir, { encoding: 'utf8', withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) {
        return;
      }
      const filePath = join(safeSessionsDir, entry.name);
      try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink()) return;
        if (now - info.mtimeMs > SESSION_MAX_AGE_MS) {
          await rm(filePath);
        }
      } catch (error) {
        console.warn(`[SessionCleaner] 跳过无法清理的会话: ${filePath}`, error);
      }
    }),
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
