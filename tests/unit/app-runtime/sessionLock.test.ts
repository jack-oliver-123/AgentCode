import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionLock,
  SessionLockedError,
  type ProcessInspection,
} from '../../../src/app/session/sessionLock.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcode-lock-'));
  tempRoots.push(root);
  return root;
}

describe('SessionLock', () => {
  it('acquires exclusively, is idempotent for the same instance, and releases its own nonce', async () => {
    const root = await tempRoot();
    const lock = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 10, processStartId: 'start-10' },
      nonce: () => 'nonce-1',
      now: () => 100,
    });

    const first = await lock.acquire();
    const second = await lock.acquire();
    expect(second).toBe(first);
    expect(JSON.parse(await readFile(lock.filePath, 'utf8'))).toMatchObject({
      sessionId: '20260720-100000-abcd',
      ownerPid: 10,
      processStartId: 'start-10',
      nonce: 'nonce-1',
    });

    await lock.release();
    await expect(readFile(lock.filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a lock owned by a live process without offering force takeover', async () => {
    const root = await tempRoot();
    const first = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 10, processStartId: 'start-10' },
      nonce: () => 'nonce-1',
    });
    await first.acquire();

    const second = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 20, processStartId: 'start-20' },
      inspectProcess: async (): Promise<ProcessInspection> => ({ exists: true, processStartId: 'start-10' }),
    });

    await expect(second.acquire()).rejects.toBeInstanceOf(SessionLockedError);
    expect(JSON.parse(await readFile(first.filePath, 'utf8'))).toMatchObject({ nonce: 'nonce-1' });
  });

  it('cleans a stale lock only after confirming the owner PID no longer exists', async () => {
    const root = await tempRoot();
    const stale = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 10, processStartId: 'start-10' },
      nonce: () => 'old',
    });
    await stale.acquire();

    const replacement = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 20, processStartId: 'start-20' },
      nonce: () => 'new',
      inspectProcess: async () => ({ exists: false }),
    });
    await replacement.acquire();

    expect(JSON.parse(await readFile(replacement.filePath, 'utf8'))).toMatchObject({
      ownerPid: 20,
      nonce: 'new',
    });
  });

  it('cleans a reused PID only when a reliable start identity mismatches', async () => {
    const root = await tempRoot();
    const stale = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 10, processStartId: 'old-start' },
      nonce: () => 'old',
    });
    await stale.acquire();

    const replacement = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 20, processStartId: 'start-20' },
      nonce: () => 'new',
      inspectProcess: async () => ({ exists: true, processStartId: 'new-start' }),
    });
    await replacement.acquire();

    expect(JSON.parse(await readFile(replacement.filePath, 'utf8'))).toMatchObject({ ownerPid: 20 });
  });

  it('does not delete a lock whose nonce changes during release', async () => {
    const root = await tempRoot();
    const lock = new SessionLock({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      owner: { pid: 10, processStartId: 'start-10' },
      nonce: () => 'ours',
    });
    await lock.acquire();
    const record = JSON.parse(await readFile(lock.filePath, 'utf8'));
    await writeFile(lock.filePath, JSON.stringify({ ...record, nonce: 'replacement' }), 'utf8');

    await lock.release();
    expect(JSON.parse(await readFile(lock.filePath, 'utf8'))).toMatchObject({ nonce: 'replacement' });
  });
});
