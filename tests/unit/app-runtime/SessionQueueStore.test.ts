import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SessionQueueStore,
  type SessionQueueStorage,
} from '../../../src/app/session/SessionQueueStore.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcode-queue-'));
  tempRoots.push(root);
  return root;
}

describe('SessionQueueStore', () => {
  it('persists FIFO items with their frozen Agent mode before reporting acceptance', async () => {
    const root = await tempRoot();
    let now = 100;
    const store = await SessionQueueStore.open({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
      now: () => now++,
      createId: (prefix) => `${prefix}-${now}`,
    });

    const first = await store.add('first task', 'plan');
    const second = await store.add('second task', 'default');

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(store.snapshot().items.map((item) => [item.text, item.agentMode])).toEqual([
      ['first task', 'plan'],
      ['second task', 'default'],
    ]);

    const persisted = JSON.parse(await readFile(store.filePath, 'utf8'));
    expect(persisted.items.map((item: { text: string }) => item.text)).toEqual(['first task', 'second task']);
  });

  it('does not mutate memory or accept input when persistence fails', async () => {
    let writes = 0;
    const storage: SessionQueueStorage = {
      read: async () => undefined,
      write: async () => {
        writes += 1;
        throw new Error('disk full');
      },
    };
    const store = await SessionQueueStore.open({
      storageRoot: 'C:\\unused',
      sessionId: '20260720-100000-abcd',
      storage,
    });

    await expect(store.add('must survive', 'default')).rejects.toThrow('disk full');
    expect(writes).toBe(1);
    expect(store.snapshot().items).toEqual([]);
    expect(store.snapshot().version).toBe(0);
  });

  it('rejects an oversized Queue before writing or reporting acceptance', async () => {
    const write = vi.fn(async () => undefined);
    const store = await SessionQueueStore.open({
      storageRoot: 'C:\\unused',
      sessionId: '20260720-100000-abcd',
      storage: { read: async () => undefined, write },
    });

    await expect(store.add('x'.repeat(4 * 1024 * 1024), 'default')).rejects.toThrow('Queue file exceeds');

    expect(write).not.toHaveBeenCalled();
    expect(store.snapshot()).toMatchObject({ version: 0, items: [] });
  });

  it('supports start, completion, pause/resume, remove, and clear with versioned snapshots', async () => {
    const root = await tempRoot();
    const store = await SessionQueueStore.open({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
    });
    await store.add('one', 'default');
    await store.add('two', 'plan');

    const running = await store.startNext();
    expect(running?.text).toBe('one');
    expect(store.snapshot().items[0]?.status).toBe('running');

    await store.complete(running!.id);
    expect(store.snapshot().items.map((item) => item.text)).toEqual(['two']);

    await store.pause();
    expect(store.snapshot().paused).toBe(true);
    expect(await store.startNext()).toBeUndefined();

    await store.resume();
    await store.add('three', 'default');
    const removed = await store.remove(2);
    expect(removed?.text).toBe('three');

    await store.clear();
    expect(store.snapshot()).toMatchObject({ items: [], paused: false });
    expect(store.snapshot().version).toBeGreaterThan(0);
  });

  it('recovers persisted items in order as paused without automatically draining', async () => {
    const root = await tempRoot();
    const options = { storageRoot: root, sessionId: '20260720-100000-abcd' } as const;
    const original = await SessionQueueStore.open(options);
    await original.add('one', 'default');
    await original.add('two', 'plan');
    const running = await original.startNext();
    expect(running?.text).toBe('one');

    const restored = await SessionQueueStore.open(options);
    expect(restored.snapshot()).toMatchObject({ paused: true, restored: true });
    expect(restored.snapshot().items.map((item) => [item.text, item.agentMode, item.status])).toEqual([
      ['one', 'default', 'queued'],
      ['two', 'plan', 'queued'],
    ]);
    expect(await restored.startNext()).toBeUndefined();
  });

  it('serializes concurrent writes without losing accepted items', async () => {
    const root = await tempRoot();
    const store = await SessionQueueStore.open({
      storageRoot: root,
      sessionId: '20260720-100000-abcd',
    });

    await Promise.all([
      store.add('one', 'default'),
      store.add('two', 'default'),
      store.add('three', 'default'),
    ]);

    expect(store.snapshot().items.map((item) => item.text)).toEqual(['one', 'two', 'three']);
  });
});
