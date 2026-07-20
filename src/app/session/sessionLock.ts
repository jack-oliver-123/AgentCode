import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ensurePrivateDirectory,
  type FileFingerprint,
  fingerprintsMatch,
  readSafeFile,
} from '../../shared/safeFs.js';

const LOCK_FILE_MODE = 0o600;
const MAX_LOCK_BYTES = 16 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const CURRENT_PROCESS_START_ID = `${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;

export interface ProcessOwner {
  pid: number;
  processStartId: string;
}

export interface ProcessInspection {
  exists: boolean;
  processStartId?: string;
}

export interface SessionLockRecord {
  schemaVersion: 1;
  sessionId: string;
  ownerPid: number;
  processStartId: string;
  createdAt: number;
  nonce: string;
}

export interface SessionLockOptions {
  storageRoot: string;
  sessionId: string;
  filePath?: string;
  owner?: ProcessOwner;
  inspectProcess?: (pid: number) => Promise<ProcessInspection>;
  now?: () => number;
  nonce?: () => string;
}

export class SessionLockedError extends Error {
  constructor(readonly record: SessionLockRecord) {
    super(`Session ${record.sessionId} is locked by PID ${record.ownerPid}.`);
    this.name = 'SessionLockedError';
  }
}

export class SessionLockUnverifiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLockUnverifiableError';
  }
}

interface ReadLock {
  record: SessionLockRecord;
  fingerprint: FileFingerprint;
}

export class SessionLock {
  readonly filePath: string;

  private readonly storageRoot: string;
  private readonly owner: ProcessOwner;
  private readonly inspectProcess: (pid: number) => Promise<ProcessInspection>;
  private lease: SessionLockRecord | undefined;

  constructor(private readonly options: SessionLockOptions) {
    if (!SESSION_ID_PATTERN.test(options.sessionId)) throw new Error(`Invalid session ID: ${options.sessionId}`);
    this.storageRoot = resolve(options.storageRoot);
    this.filePath = options.filePath ?? join(this.storageRoot, '.agentcode', 'sessions', `${options.sessionId}.lock`);
    this.owner = options.owner ?? { pid: process.pid, processStartId: CURRENT_PROCESS_START_ID };
    this.inspectProcess = options.inspectProcess ?? defaultInspectProcess;
  }

  async acquire(): Promise<SessionLockRecord> {
    if (this.lease !== undefined) return this.lease;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record: SessionLockRecord = {
        schemaVersion: 1,
        sessionId: this.options.sessionId,
        ownerPid: this.owner.pid,
        processStartId: this.owner.processStartId,
        createdAt: (this.options.now ?? Date.now)(),
        nonce: (this.options.nonce ?? randomUUID)(),
      };
      try {
        await this.createLockFile(record);
        this.lease = record;
        return record;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }

      const existing = await this.readLock();
      if (existing === undefined) continue;
      if (!(await this.isConfirmedStale(existing.record))) {
        throw new SessionLockedError(existing.record);
      }
      await this.removeIfUnchanged(existing);
    }

    throw new SessionLockUnverifiableError(`Unable to acquire session lock after stale cleanup: ${this.filePath}`);
  }

  async release(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    if (lease === undefined) return;
    let current: ReadLock | undefined;
    try {
      current = await this.readLock();
    } catch {
      return;
    }
    if (
      current === undefined ||
      current.record.nonce !== lease.nonce ||
      current.record.ownerPid !== lease.ownerPid ||
      current.record.processStartId !== lease.processStartId
    ) {
      return;
    }
    await this.removeIfUnchanged(current).catch(() => undefined);
  }

  private async createLockFile(record: SessionLockRecord): Promise<void> {
    const directory = await ensurePrivateDirectory(
      this.storageRoot,
      join(this.storageRoot, '.agentcode', 'sessions'),
      0o700,
    );
    const target = this.options.filePath ?? join(directory, `${this.options.sessionId}.lock`);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, LOCK_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      if (process.platform !== 'win32') await chmod(target, LOCK_FILE_MODE);
    } finally {
      await handle.close();
    }
  }

  private async readLock(): Promise<ReadLock | undefined> {
    const result = await readSafeFile(this.storageRoot, this.filePath, MAX_LOCK_BYTES);
    if (result === undefined) return undefined;
    if (result.truncated) throw new SessionLockUnverifiableError(`Session lock file is too large: ${this.filePath}`);
    let value: unknown;
    try {
      value = JSON.parse(result.buffer.toString('utf8'));
    } catch {
      throw new SessionLockUnverifiableError(`Session lock file is invalid JSON: ${this.filePath}`);
    }
    const record = parseLockRecord(value, this.options.sessionId);
    return { record, fingerprint: result.fingerprint };
  }

  private async isConfirmedStale(record: SessionLockRecord): Promise<boolean> {
    let inspection: ProcessInspection;
    try {
      inspection = await this.inspectProcess(record.ownerPid);
    } catch (error) {
      throw new SessionLockUnverifiableError(
        `Unable to verify lock owner PID ${record.ownerPid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!inspection.exists) return true;
    return inspection.processStartId !== undefined && inspection.processStartId !== record.processStartId;
  }

  private async removeIfUnchanged(expected: ReadLock): Promise<void> {
    const current = await this.readLock();
    if (
      current === undefined ||
      current.record.nonce !== expected.record.nonce ||
      !fingerprintsMatch(current.fingerprint, expected.fingerprint)
    ) {
      throw new SessionLockUnverifiableError('Session lock changed while it was being verified; refusing to delete it.');
    }
    await rm(this.filePath);
  }
}

async function defaultInspectProcess(pid: number): Promise<ProcessInspection> {
  if (pid === process.pid) return { exists: true, processStartId: CURRENT_PROCESS_START_ID };
  try {
    process.kill(pid, 0);
    return { exists: true };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return { exists: false };
    if (isNodeError(error) && error.code === 'EPERM') return { exists: true };
    throw error;
  }
}

function parseLockRecord(value: unknown, expectedSessionId: string): SessionLockRecord {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['sessionId'] !== expectedSessionId ||
    !Number.isSafeInteger(value['ownerPid']) ||
    (value['ownerPid'] as number) <= 0 ||
    typeof value['processStartId'] !== 'string' ||
    value['processStartId'].length === 0 ||
    typeof value['createdAt'] !== 'number' ||
    !Number.isFinite(value['createdAt']) ||
    typeof value['nonce'] !== 'string' ||
    value['nonce'].length === 0
  ) {
    throw new SessionLockUnverifiableError('Session lock has an invalid schema or owner identity.');
  }
  return {
    schemaVersion: 1,
    sessionId: expectedSessionId,
    ownerPid: value['ownerPid'] as number,
    processStartId: value['processStartId'],
    createdAt: value['createdAt'],
    nonce: value['nonce'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
