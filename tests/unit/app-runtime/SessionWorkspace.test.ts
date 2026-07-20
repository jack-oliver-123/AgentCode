import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SessionSelectionError,
  SessionWorkspace,
  type SessionWorkspaceController,
} from '../../../src/app/session/SessionWorkspace.js';
import { SessionLock, SessionLockedError } from '../../../src/app/session/sessionLock.js';
import type { RestoredSession } from '../../../src/session/SessionRestore.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcode-workspace-'));
  tempRoots.push(root);
  return root;
}

interface FakeController extends SessionWorkspaceController {
  id: string;
  close: () => void;
}

function restored(sessionId: string, filePath: string): RestoredSession {
  return {
    providerContext: [],
    messages: [],
    source: {
      sessionId,
      filePath,
      expectedFile: { size: 0, mtimeMs: 0, dev: 0, ino: 0 },
    },
  };
}

describe('SessionWorkspace', () => {
  it('creates a Default session with selected permission mode and an empty Queue', async () => {
    const root = await tempRoot();
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'auto',
      createSessionId: () => 'session-a',
      createController: async ({ session }) => ({ id: session.id, close: vi.fn() }),
    });

    expect(workspace.getActiveSnapshot()).toMatchObject({
      id: 'session-a',
      agentMode: 'default',
      selectedPermissionMode: 'auto',
      resumed: false,
      turnCount: 0,
    });
    expect(workspace.getActiveQueue().snapshot()).toMatchObject({
      sessionId: 'session-a',
      items: [],
      paused: false,
    });

    await workspace.close();
  });

  it('atomically switches candidates and restores a session-scoped Queue as paused', async () => {
    const root = await tempRoot();
    const ids = ['session-a', 'session-b'];
    const createController = vi.fn(async ({ session }) => ({ id: session.id, close: vi.fn() }));
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'normal',
      createSessionId: () => ids.shift()!,
      createController,
      loadSession: async (filePath) => restored(filePath.endsWith('session-a.jsonl') ? 'session-a' : 'session-b', filePath),
    });
    const firstController = workspace.getActiveController();
    await workspace.renameSession('alpha');
    await workspace.getActiveQueue().add('queued for alpha', 'plan');

    await workspace.createSession({ name: 'beta', selectedPermissionMode: 'yolo' });
    expect(workspace.getActiveSnapshot()).toMatchObject({
      id: 'session-b',
      name: 'beta',
      agentMode: 'default',
      selectedPermissionMode: 'yolo',
    });
    expect(firstController.close).toHaveBeenCalledOnce();

    const result = await workspace.resumeSession('session-a');
    expect(result).toMatchObject({ kind: 'activated', session: { id: 'session-a', name: 'alpha' } });
    expect(workspace.getActiveQueue().snapshot()).toMatchObject({ paused: true });
    expect(workspace.getActiveQueue().snapshot().items.map((item) => item.text)).toEqual(['queued for alpha']);
    expect(createController).toHaveBeenLastCalledWith(expect.objectContaining({ restored: expect.any(Object) }));

    await workspace.close();
  });

  it('keeps the old active session when candidate construction fails and releases the candidate lock', async () => {
    const root = await tempRoot();
    const ids = ['session-a', 'session-b'];
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'normal',
      createSessionId: () => ids.shift()!,
      createController: async ({ session }) => {
        if (session.id === 'session-b') throw new Error('controller failed');
        return { id: session.id, close: vi.fn() };
      },
    });

    await expect(workspace.createSession({ name: 'broken' })).rejects.toThrow('controller failed');
    expect(workspace.getActiveSnapshot().id).toBe('session-a');

    const candidateLock = new SessionLock({ storageRoot: root, sessionId: 'session-b' });
    await expect(candidateLock.acquire()).resolves.toMatchObject({ sessionId: 'session-b' });
    await candidateLock.release();
    await workspace.close();
  });

  it('applies ID, exact Unicode name, then case-folded name matching and reports ambiguity', async () => {
    const root = await tempRoot();
    const ids = ['session-a', 'session-b', 'session-c'];
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'normal',
      createSessionId: () => ids.shift()!,
      createController: async ({ session }) => ({ id: session.id, close: vi.fn() }),
      loadSession: async (filePath) => restored(/(session-[abc])\.jsonl$/u.exec(filePath)![1]!, filePath),
    });
    await workspace.renameSession('Résumé');
    await workspace.createSession({ name: 'résumé' });
    await workspace.createSession({ name: 'other' });

    await expect(workspace.resumeSession('RÉSUMÉ')).rejects.toMatchObject({
      code: 'ambiguous',
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: 'session-a' }),
        expect.objectContaining({ id: 'session-b' }),
      ]),
    });
    expect(workspace.getActiveSnapshot().id).toBe('session-c');

    expect(await workspace.resumeSession('session-c')).toEqual({
      kind: 'already_active',
      session: workspace.getActiveSnapshot(),
    });
    await expect(workspace.resumeSession('missing')).rejects.toBeInstanceOf(SessionSelectionError);
    await workspace.close();
  });

  it('rejects a valid external lock and leaves the active session unchanged', async () => {
    const root = await tempRoot();
    const ids = ['session-a', 'session-b'];
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'normal',
      createSessionId: () => ids.shift()!,
      createController: async ({ session }) => ({ id: session.id, close: vi.fn() }),
      loadSession: async (filePath) => restored('session-a', filePath),
    });
    await workspace.createSession({ name: 'active' });
    const external = new SessionLock({ storageRoot: root, sessionId: 'session-a' });
    await external.acquire();

    expect((await workspace.listSessions()).find((session) => session.id === 'session-a')).toMatchObject({
      locked: true,
      restorable: false,
    });
    await expect(workspace.resumeSession('session-a')).rejects.toBeInstanceOf(SessionLockedError);
    expect(workspace.getActiveSnapshot().id).toBe('session-b');

    await external.release();
    await workspace.close();
  });

  it('renames metadata without replacing the active controller', async () => {
    const root = await tempRoot();
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'strict',
      createSessionId: () => 'session-a',
      createController: async ({ session }) => ({ id: session.id, close: vi.fn() }),
    });
    const controller = workspace.getActiveController();

    await workspace.renameSession('new name');

    expect(workspace.getActiveController()).toBe(controller);
    expect(workspace.getActiveSnapshot().name).toBe('new name');
    expect((await workspace.listSessions()).find((session) => session.id === 'session-a')?.name).toBe('new name');
    await workspace.close();
  });

  it('persists Agent mode, selected permission mode, and turn count for resume', async () => {
    const root = await tempRoot();
    const archivePath = join(root, '.agentcode', 'sessions', 'session-a.jsonl');
    const first = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'normal',
      createSessionId: () => 'session-a',
      createController: async ({ session }) => ({ id: session.id, close: vi.fn() }),
    });

    await first.setAgentMode('plan');
    await first.setSelectedPermissionMode('yolo');
    await first.recordTurn();
    await first.close();

    const resumedWorkspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'strict',
      initial: { restored: restored('session-a', archivePath) },
      createController: async ({ session }) => ({ id: session.id, close: vi.fn() }),
    });

    expect(resumedWorkspace.getActiveSnapshot()).toMatchObject({
      id: 'session-a',
      agentMode: 'plan',
      selectedPermissionMode: 'yolo',
      turnCount: 1,
      resumed: true,
    });
    await resumedWorkspace.close();
  });

  it('resumes a metadata-only zero-turn session whose JSONL archive was never created', async () => {
    const root = await tempRoot();
    const ids = ['session-a', 'session-b'];
    const createController = vi.fn(async ({ session }) => ({ id: session.id, close: vi.fn() }));
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'normal',
      createSessionId: () => ids.shift()!,
      createController,
    });
    await workspace.createSession();

    await expect(workspace.resumeSession('session-a')).resolves.toMatchObject({
      kind: 'activated',
      session: { id: 'session-a', turnCount: 0 },
    });
    expect(createController).toHaveBeenLastCalledWith(expect.objectContaining({
      restored: { providerContext: [], messages: [], activities: [] },
    }));
    await workspace.close();
  });

  it('counts legacy archive turns from ordinary user messages instead of all records', async () => {
    const root = await tempRoot();
    const sessionsDir = join(root, '.agentcode', 'sessions');
    const legacyId = '20260720-101500-abcd';
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, `${legacyId}.jsonl`), [
      JSON.stringify({ role: 'user', content: 'question', _ts: 1, _ui: { id: 'u-1', createdAt: 1, author: 'user' } }),
      JSON.stringify({ role: 'assistant', content: 'answer', _ts: 2, _ui: { id: 'a-1', createdAt: 2, author: 'agent' } }),
      JSON.stringify({ role: 'user', content: 'guidance', provenance: 'steer', _ts: 3 }),
    ].join('\n'), 'utf8');
    const workspace = await SessionWorkspace.open<FakeController>({
      storageRoot: root,
      selectedPermissionMode: 'normal',
      createSessionId: () => 'session-current',
      createController: async ({ session }) => ({ id: session.id, close: vi.fn() }),
    });

    expect((await workspace.listSessions()).find((session) => session.id === legacyId)?.turnCount).toBe(1);
    await workspace.close();
  });
});
