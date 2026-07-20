import { join, resolve } from 'node:path';

import { createId, type IdGenerator } from '../../shared/ids.js';
import { atomicWritePrivateFile, readSafeFile } from '../../shared/safeFs.js';
import type { AgentMode } from '../runtime/types.js';

const QUEUE_FILE_MODE = 0o600;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export type SessionQueueItemStatus = 'queued' | 'running';

export interface SessionQueueItem {
  id: string;
  text: string;
  enqueuedAt: number;
  agentMode: AgentMode;
  status: SessionQueueItemStatus;
}

export interface SessionQueueSnapshot {
  sessionId: string;
  version: number;
  paused: boolean;
  restored: boolean;
  items: readonly SessionQueueItem[];
}

interface PersistedQueueState {
  schemaVersion: 1;
  sessionId: string;
  version: number;
  paused: boolean;
  items: SessionQueueItem[];
}

export interface SessionQueueStorage {
  read(): Promise<string | undefined>;
  write(serialized: string): Promise<void>;
}

export interface SessionQueueStoreOptions {
  storageRoot: string;
  sessionId: string;
  filePath?: string;
  storage?: SessionQueueStorage;
  now?: () => number;
  createId?: IdGenerator;
}

export interface QueueAcceptance {
  accepted: true;
  item: SessionQueueItem;
}

export class SessionQueueStore {
  readonly filePath: string;

  private state: SessionQueueSnapshot;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: SessionQueueStoreOptions,
    private readonly storage: SessionQueueStorage,
    initial: SessionQueueSnapshot,
  ) {
    this.filePath = options.filePath ?? defaultQueuePath(options.storageRoot, options.sessionId);
    this.state = initial;
  }

  static async open(options: SessionQueueStoreOptions): Promise<SessionQueueStore> {
    assertSessionId(options.sessionId);
    const filePath = options.filePath ?? defaultQueuePath(options.storageRoot, options.sessionId);
    const storage = options.storage ?? createFileQueueStorage(options.storageRoot, filePath);
    const serialized = await storage.read();
    if (serialized !== undefined) assertQueueSize(serialized, filePath);
    const initial = serialized === undefined
      ? emptySnapshot(options.sessionId)
      : restoredSnapshot(parsePersistedQueue(serialized, options.sessionId));
    return new SessionQueueStore(options, storage, initial);
  }

  snapshot(): SessionQueueSnapshot {
    return {
      ...this.state,
      items: this.state.items.map((item) => ({ ...item })),
    };
  }

  add(text: string, agentMode: AgentMode): Promise<QueueAcceptance> {
    const normalized = text.trim();
    if (normalized.length === 0) return Promise.reject(new Error('Queue item text must not be empty.'));
    return this.serialize(async () => {
      const item: SessionQueueItem = {
        id: (this.options.createId ?? createId)('queue'),
        text: normalized,
        enqueuedAt: (this.options.now ?? Date.now)(),
        agentMode,
        status: 'queued',
      };
      const next = this.nextState({ items: [...this.state.items, item] });
      await this.persistAndCommit(next);
      return { accepted: true, item: { ...item } };
    });
  }

  startNext(): Promise<SessionQueueItem | undefined> {
    return this.serialize(async () => {
      if (this.state.paused || this.state.items.some((item) => item.status === 'running')) return undefined;
      const index = this.state.items.findIndex((item) => item.status === 'queued');
      if (index < 0) return undefined;
      const items = this.state.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, status: 'running' as const } : item,
      );
      const next = this.nextState({ items });
      await this.persistAndCommit(next);
      return { ...items[index]! };
    });
  }

  complete(itemId: string): Promise<SessionQueueItem | undefined> {
    return this.serialize(async () => {
      const item = this.state.items.find((candidate) => candidate.id === itemId);
      if (item === undefined) return undefined;
      const next = this.nextState({ items: this.state.items.filter((candidate) => candidate.id !== itemId) });
      await this.persistAndCommit(next);
      return { ...item };
    });
  }

  fail(itemId: string): Promise<SessionQueueItem | undefined> {
    return this.serialize(async () => {
      const index = this.state.items.findIndex((candidate) => candidate.id === itemId);
      const item = this.state.items[index];
      if (item === undefined) return undefined;
      const items = this.state.items.map((candidate, itemIndex) =>
        itemIndex === index ? { ...candidate, status: 'queued' as const } : candidate,
      );
      const next = this.nextState({ items, paused: true });
      await this.persistAndCommit(next);
      return { ...items[index]! };
    });
  }

  pause(): Promise<void> {
    return this.serialize(async () => {
      if (this.state.paused) return;
      await this.persistAndCommit(this.nextState({ paused: true }));
    });
  }

  resume(): Promise<void> {
    return this.serialize(async () => {
      if (!this.state.paused) return;
      await this.persistAndCommit(this.nextState({ paused: false }));
    });
  }

  remove(index: number): Promise<SessionQueueItem | undefined> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(index) || index < 1) throw new RangeError('Queue index must be a positive integer.');
      const item = this.state.items[index - 1];
      if (item === undefined) return undefined;
      if (item.status === 'running') throw new Error('Cannot remove a running Queue item.');
      const next = this.nextState({ items: this.state.items.filter((_, itemIndex) => itemIndex !== index - 1) });
      await this.persistAndCommit(next);
      return { ...item };
    });
  }

  clear(): Promise<void> {
    return this.serialize(async () => {
      if (this.state.items.some((item) => item.status === 'running')) {
        throw new Error('Cannot clear Queue while an item is running.');
      }
      if (this.state.items.length === 0 && !this.state.paused) return;
      await this.persistAndCommit(this.nextState({ items: [], paused: false }));
    });
  }

  private nextState(changes: Partial<Pick<SessionQueueSnapshot, 'items' | 'paused'>>): SessionQueueSnapshot {
    return {
      ...this.state,
      ...changes,
      version: this.state.version + 1,
    };
  }

  private async persistAndCommit(next: SessionQueueSnapshot): Promise<void> {
    const serialized = serializeQueue(next);
    assertQueueSize(serialized, this.filePath);
    await this.storage.write(serialized);
    this.state = next;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function createFileQueueStorage(storageRoot: string, filePath: string): SessionQueueStorage {
  const root = resolve(storageRoot);
  return {
    read: async () => {
      const result = await readSafeFile(root, filePath, MAX_QUEUE_BYTES);
      if (result === undefined) return undefined;
      if (result.truncated) throw new Error(`Queue file exceeds ${MAX_QUEUE_BYTES} bytes: ${filePath}`);
      return result.buffer.toString('utf8');
    },
    write: (serialized) => atomicWritePrivateFile(root, filePath, serialized, QUEUE_FILE_MODE),
  };
}

function defaultQueuePath(storageRoot: string, sessionId: string): string {
  return join(resolve(storageRoot), '.agentcode', 'sessions', `${sessionId}.queue.json`);
}

function emptySnapshot(sessionId: string): SessionQueueSnapshot {
  return { sessionId, version: 0, paused: false, restored: false, items: [] };
}

function restoredSnapshot(persisted: PersistedQueueState): SessionQueueSnapshot {
  const items = persisted.items.map((item) => ({ ...item, status: 'queued' as const }));
  return {
    sessionId: persisted.sessionId,
    version: persisted.version,
    paused: items.length > 0 || persisted.paused,
    restored: true,
    items,
  };
}

function serializeQueue(snapshot: SessionQueueSnapshot): string {
  const persisted: PersistedQueueState = {
    schemaVersion: 1,
    sessionId: snapshot.sessionId,
    version: snapshot.version,
    paused: snapshot.paused,
    items: snapshot.items.map((item) => ({ ...item })),
  };
  return `${JSON.stringify(persisted, null, 2)}\n`;
}

function assertQueueSize(serialized: string, filePath: string): void {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_QUEUE_BYTES) {
    throw new Error(`Queue file exceeds ${MAX_QUEUE_BYTES} bytes: ${filePath}`);
  }
}

function parsePersistedQueue(serialized: string, expectedSessionId: string): PersistedQueueState {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Queue file contains invalid JSON.');
  }
  if (!isRecord(value) || value['schemaVersion'] !== 1 || value['sessionId'] !== expectedSessionId) {
    throw new Error('Queue file has an invalid schema or session identity.');
  }
  if (!Number.isSafeInteger(value['version']) || (value['version'] as number) < 0 || typeof value['paused'] !== 'boolean') {
    throw new Error('Queue file has invalid version or paused state.');
  }
  if (!Array.isArray(value['items'])) throw new Error('Queue file items must be an array.');
  const ids = new Set<string>();
  const items = value['items'].map((item): SessionQueueItem => {
    if (
      !isRecord(item) ||
      typeof item['id'] !== 'string' ||
      item['id'].length === 0 ||
      ids.has(item['id']) ||
      typeof item['text'] !== 'string' ||
      item['text'].trim().length === 0 ||
      typeof item['enqueuedAt'] !== 'number' ||
      !Number.isFinite(item['enqueuedAt']) ||
      (item['agentMode'] !== 'default' && item['agentMode'] !== 'plan') ||
      (item['status'] !== 'queued' && item['status'] !== 'running')
    ) {
      throw new Error('Queue file contains an invalid item.');
    }
    ids.add(item['id']);
    return {
      id: item['id'],
      text: item['text'],
      enqueuedAt: item['enqueuedAt'],
      agentMode: item['agentMode'],
      status: item['status'],
    };
  });
  return {
    schemaVersion: 1,
    sessionId: expectedSessionId,
    version: value['version'] as number,
    paused: value['paused'],
    items,
  };
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
