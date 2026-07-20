import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  atomicWritePrivateFile,
  findSafeDirectory,
  readSafeFile,
} from '../../shared/safeFs.js';
import {
  type RestoredSession,
  listSessions as listArchivedSessions,
  loadSession as loadArchivedSession,
} from '../../session/SessionRestore.js';
import type { AgentMode, PermissionMode, SessionSnapshot } from '../runtime/types.js';
import { SessionQueueStore } from './SessionQueueStore.js';
import { SessionLock } from './sessionLock.js';

const METADATA_FILE_MODE = 0o600;
const MAX_METADATA_BYTES = 64 * 1024;
const META_SUFFIX = '.meta.json';

export interface SessionWorkspaceController {
  close?(): void | Promise<void>;
}

export interface SessionControllerFactoryInput {
  session: SessionSnapshot;
  restored?: RestoredSession;
}

export interface WorkspaceSessionSummary {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  archivePath: string;
  agentMode: AgentMode;
  selectedPermissionMode: PermissionMode;
  current: boolean;
  locked?: boolean;
  restorable?: boolean;
}

export interface SessionWorkspaceOpenOptions<TController extends SessionWorkspaceController> {
  storageRoot: string;
  selectedPermissionMode: PermissionMode;
  createController: (input: SessionControllerFactoryInput) => TController | Promise<TController>;
  initial?: {
    restored?: RestoredSession;
    sessionId?: string;
    name?: string;
    agentMode?: AgentMode;
  };
  createSessionId?: () => string;
  now?: () => number;
  loadSession?: (filePath: string) => Promise<RestoredSession>;
  listArchivedSessions?: typeof listArchivedSessions;
  createLock?: (sessionId: string) => SessionLock;
  createQueue?: (sessionId: string) => Promise<SessionQueueStore>;
}

export interface CreateSessionOptions {
  name?: string;
  selectedPermissionMode?: PermissionMode;
}

export type SessionActivationResult =
  | { kind: 'activated'; session: SessionSnapshot }
  | { kind: 'already_active'; session: SessionSnapshot };

export type SessionSelectionErrorCode = 'not_found' | 'ambiguous';

export class SessionSelectionError extends Error {
  constructor(
    readonly code: SessionSelectionErrorCode,
    message: string,
    readonly candidates: readonly WorkspaceSessionSummary[] = [],
  ) {
    super(message);
    this.name = 'SessionSelectionError';
  }
}

interface SessionCandidate<TController extends SessionWorkspaceController> {
  session: SessionSnapshot;
  controller: TController;
  queue: SessionQueueStore;
  lock: SessionLock;
}

interface StoredSessionMetadata {
  schemaVersion: 1;
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  agentMode: AgentMode;
  selectedPermissionMode: PermissionMode;
}

export class SessionWorkspace<TController extends SessionWorkspaceController = SessionWorkspaceController> {
  private active!: SessionCandidate<TController>;
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly options: SessionWorkspaceOpenOptions<TController>) {}

  static async open<TController extends SessionWorkspaceController>(
    options: SessionWorkspaceOpenOptions<TController>,
  ): Promise<SessionWorkspace<TController>> {
    const workspace = new SessionWorkspace(options);

    const root = resolve(options.storageRoot);
    const restored = options.initial?.restored;
    const sessionId = restored?.source?.sessionId ?? options.initial?.sessionId ?? (options.createSessionId ?? createSessionId)();
    const existingMetadata = restored === undefined ? undefined : await readSessionMetadata(root, sessionId);
    const now = (options.now ?? Date.now)();
    const archivePath = restored?.source?.filePath ?? sessionArchivePath(root, sessionId);
    const session = toSessionSnapshot(
      existingMetadata ?? {
        schemaVersion: 1,
        id: sessionId,
        ...(options.initial?.name !== undefined ? { name: options.initial.name } : {}),
        createdAt: now,
        updatedAt: now,
        turnCount: restored?.messages.filter((message) => message.role === 'user').length ?? 0,
        agentMode: options.initial?.agentMode ?? 'default',
        selectedPermissionMode: options.selectedPermissionMode,
      },
      archivePath,
      restored !== undefined,
    );
    const active = await workspace.buildCandidate(session, async () => restored);
    workspace.active = active;
    try {
      await writeSessionMetadata(root, fromSessionSnapshot(session));
    } catch (error) {
      await workspace.disposeCandidate(active);
      throw error;
    }
    return workspace;
  }

  getActiveSnapshot(): SessionSnapshot {
    return cloneSessionSnapshot(this.active.session);
  }

  getActiveController(): TController {
    return this.active.controller;
  }

  getActiveQueue(): SessionQueueStore {
    return this.active.queue;
  }

  createSession(options: CreateSessionOptions = {}): Promise<SessionActivationResult> {
    return this.serialize(async () => {
      const root = resolve(this.options.storageRoot);
      const sessionId = (this.options.createSessionId ?? createSessionId)();
      const now = (this.options.now ?? Date.now)();
      const name = normalizeOptionalName(options.name);
      const session: SessionSnapshot = {
        id: sessionId,
        ...(name !== undefined ? { name } : {}),
        createdAt: now,
        updatedAt: now,
        turnCount: 0,
        resumed: false,
        agentMode: 'default',
        selectedPermissionMode: options.selectedPermissionMode ?? this.active.session.selectedPermissionMode,
        archivePath: sessionArchivePath(root, sessionId),
      };
      const candidate = await this.buildCandidate(session);
      try {
        await writeSessionMetadata(root, fromSessionSnapshot(session));
      } catch (error) {
        await this.disposeCandidate(candidate);
        throw error;
      }
      await this.activate(candidate);
      return { kind: 'activated', session: this.getActiveSnapshot() };
    });
  }

  resumeSession(target: string): Promise<SessionActivationResult> {
    return this.serialize(async () => {
      const summary = resolveSessionTarget(target, await this.listSessionsInternal());
      if (summary.id === this.active.session.id) {
        return { kind: 'already_active', session: this.getActiveSnapshot() };
      }

      const metadata = await readSessionMetadata(resolve(this.options.storageRoot), summary.id);
      const session = toSessionSnapshot(
        metadata ?? {
          schemaVersion: 1,
          id: summary.id,
          ...(summary.name !== undefined ? { name: summary.name } : {}),
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          turnCount: summary.turnCount,
          agentMode: summary.agentMode,
          selectedPermissionMode: summary.selectedPermissionMode,
        },
        summary.archivePath,
        true,
      );
      const candidate = await this.buildCandidate(session, async () => {
        if (metadata?.turnCount === 0 && this.options.loadSession === undefined) {
          const archive = await readSafeFile(resolve(this.options.storageRoot), summary.archivePath, 1);
          if (archive === undefined) return { providerContext: [], messages: [], activities: [] };
        }
        const load = this.options.loadSession ?? ((filePath: string) => loadArchivedSession(filePath, this.options.storageRoot));
        const restored = await load(summary.archivePath);
        if (restored.source !== undefined && restored.source.sessionId !== summary.id) {
          throw new Error(`Restored session identity mismatch: expected ${summary.id}, got ${restored.source.sessionId}`);
        }
        return restored;
      });
      await this.activate(candidate);
      return { kind: 'activated', session: this.getActiveSnapshot() };
    });
  }

  renameSession(name: string): Promise<void> {
    return this.serialize(async () => {
      const normalized = normalizeRequiredName(name);
      const updatedAt = (this.options.now ?? Date.now)();
      const next: SessionSnapshot = { ...this.active.session, name: normalized, updatedAt };
      await writeSessionMetadata(resolve(this.options.storageRoot), fromSessionSnapshot(next));
      this.active = { ...this.active, session: freezeSessionSnapshot(next) };
    });
  }

  setAgentMode(agentMode: AgentMode): Promise<void> {
    return this.updateActiveSession({ agentMode });
  }

  setSelectedPermissionMode(selectedPermissionMode: PermissionMode): Promise<void> {
    return this.updateActiveSession({ selectedPermissionMode });
  }

  recordTurn(): Promise<void> {
    return this.serialize(async () => {
      const next: SessionSnapshot = {
        ...this.active.session,
        turnCount: this.active.session.turnCount + 1,
        updatedAt: (this.options.now ?? Date.now)(),
      };
      await writeSessionMetadata(resolve(this.options.storageRoot), fromSessionSnapshot(next));
      this.active = { ...this.active, session: freezeSessionSnapshot(next) };
    });
  }

  listSessions(): Promise<readonly WorkspaceSessionSummary[]> {
    return this.listSessionsInternal();
  }

  async resolveSession(target: string): Promise<WorkspaceSessionSummary> {
    return resolveSessionTarget(target, await this.listSessionsInternal());
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      await this.disposeCandidate(this.active);
    });
  }

  private async listSessionsInternal(): Promise<WorkspaceSessionSummary[]> {
    const root = resolve(this.options.storageRoot);
    const [metadataEntries, archived] = await Promise.all([
      listSessionMetadata(root),
      (this.options.listArchivedSessions ?? listArchivedSessions)(root),
    ]);
    const byId = new Map<string, WorkspaceSessionSummary>();

    for (const metadata of metadataEntries) {
      byId.set(metadata.id, {
        id: metadata.id,
        ...(metadata.name !== undefined ? { name: metadata.name } : {}),
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        turnCount: metadata.turnCount,
        archivePath: sessionArchivePath(root, metadata.id),
        agentMode: metadata.agentMode,
        selectedPermissionMode: metadata.selectedPermissionMode,
        current: metadata.id === this.active.session.id,
      });
    }

    for (const archive of archived) {
      if (byId.has(archive.sessionId)) continue;
      const timestamp = archive.lastModified.getTime();
      byId.set(archive.sessionId, {
        id: archive.sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        turnCount: archive.turnCount,
        archivePath: archive.filePath,
        agentMode: 'default',
        selectedPermissionMode: this.options.selectedPermissionMode,
        current: archive.sessionId === this.active.session.id,
      });
    }

    const current = this.active.session;
    byId.set(current.id, {
      id: current.id,
      ...(current.name !== undefined ? { name: current.name } : {}),
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      turnCount: current.turnCount,
      archivePath: current.archivePath,
      agentMode: current.agentMode,
      selectedPermissionMode: current.selectedPermissionMode,
      current: true,
    });
    const summaries = [...byId.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
    return Promise.all(summaries.map(async (summary) => {
      const locked = summary.current ? false : await hasSessionLock(root, summary.id);
      return { ...summary, locked, restorable: !locked };
    }));
  }

  private async buildCandidate(
    session: SessionSnapshot,
    loadRestored?: () => Promise<RestoredSession | undefined>,
  ): Promise<SessionCandidate<TController>> {
    const lock = this.options.createLock?.(session.id) ?? new SessionLock({
      storageRoot: this.options.storageRoot,
      sessionId: session.id,
    });
    await lock.acquire();
    let controller: TController | undefined;
    try {
      const restored = await loadRestored?.();
      const queue = this.options.createQueue !== undefined
        ? await this.options.createQueue(session.id)
        : await SessionQueueStore.open({ storageRoot: this.options.storageRoot, sessionId: session.id });
      controller = await this.options.createController({
        session,
        ...(restored !== undefined ? { restored } : {}),
      });
      return { session: freezeSessionSnapshot(session), controller, queue, lock };
    } catch (error) {
      await controller?.close?.();
      await lock.release();
      throw error;
    }
  }

  private async activate(candidate: SessionCandidate<TController>): Promise<void> {
    const previous = this.active;
    this.active = candidate;
    await this.disposeCandidate(previous).catch((error) => {
      console.warn(`[SessionWorkspace] Failed to dispose previous session ${previous.session.id}`, error);
    });
  }

  private async disposeCandidate(candidate: SessionCandidate<TController>): Promise<void> {
    try {
      await candidate.controller.close?.();
    } finally {
      await candidate.lock.release();
    }
  }

  private updateActiveSession(
    changes: Partial<Pick<SessionSnapshot, 'agentMode' | 'selectedPermissionMode'>>,
  ): Promise<void> {
    return this.serialize(async () => {
      const next: SessionSnapshot = {
        ...this.active.session,
        ...changes,
        updatedAt: (this.options.now ?? Date.now)(),
      };
      if (
        next.agentMode === this.active.session.agentMode &&
        next.selectedPermissionMode === this.active.session.selectedPermissionMode
      ) {
        return;
      }
      await writeSessionMetadata(resolve(this.options.storageRoot), fromSessionSnapshot(next));
      this.active = { ...this.active, session: freezeSessionSnapshot(next) };
    });
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

function resolveSessionTarget(target: string, sessions: readonly WorkspaceSessionSummary[]): WorkspaceSessionSummary {
  const normalizedTarget = target.trim();
  if (normalizedTarget.length === 0) {
    throw new SessionSelectionError('not_found', 'Session target must not be empty.');
  }

  const idMatch = sessions.find((session) => session.id === normalizedTarget);
  if (idMatch !== undefined) return idMatch;

  const exactNames = sessions.filter((session) => session.name === normalizedTarget);
  if (exactNames.length === 1) return exactNames[0]!;
  if (exactNames.length > 1) throw ambiguousTarget(normalizedTarget, exactNames);

  const foldedTarget = foldName(normalizedTarget);
  const foldedNames = sessions.filter((session) => session.name !== undefined && foldName(session.name) === foldedTarget);
  if (foldedNames.length === 1) return foldedNames[0]!;
  if (foldedNames.length > 1) throw ambiguousTarget(normalizedTarget, foldedNames);

  throw new SessionSelectionError('not_found', `Session not found: ${normalizedTarget}`);
}

function ambiguousTarget(target: string, candidates: readonly WorkspaceSessionSummary[]): SessionSelectionError {
  return new SessionSelectionError('ambiguous', `Session target is ambiguous: ${target}`, candidates);
}

function foldName(name: string): string {
  return name.toLocaleLowerCase();
}

function toSessionSnapshot(metadata: StoredSessionMetadata, archivePath: string, resumed: boolean): SessionSnapshot {
  return freezeSessionSnapshot({
    id: metadata.id,
    ...(metadata.name !== undefined ? { name: metadata.name } : {}),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    turnCount: metadata.turnCount,
    resumed,
    agentMode: metadata.agentMode,
    selectedPermissionMode: metadata.selectedPermissionMode,
    archivePath,
  });
}

function fromSessionSnapshot(session: SessionSnapshot): StoredSessionMetadata {
  return {
    schemaVersion: 1,
    id: session.id,
    ...(session.name !== undefined ? { name: session.name } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turnCount,
    agentMode: session.agentMode,
    selectedPermissionMode: session.selectedPermissionMode,
  };
}

function freezeSessionSnapshot(session: SessionSnapshot): SessionSnapshot {
  return Object.freeze({ ...session });
}

function cloneSessionSnapshot(session: SessionSnapshot): SessionSnapshot {
  return { ...session };
}

function normalizeOptionalName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return normalizeRequiredName(name);
}

function normalizeRequiredName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) throw new Error('Session name must not be empty.');
  return normalized;
}

function sessionArchivePath(root: string, sessionId: string): string {
  return join(root, '.agentcode', 'sessions', `${sessionId}.jsonl`);
}

function metadataPath(root: string, sessionId: string): string {
  return join(root, '.agentcode', 'sessions', `${sessionId}${META_SUFFIX}`);
}

async function writeSessionMetadata(root: string, metadata: StoredSessionMetadata): Promise<void> {
  await atomicWritePrivateFile(root, metadataPath(root, metadata.id), `${JSON.stringify(metadata, null, 2)}\n`, METADATA_FILE_MODE);
}

async function readSessionMetadata(root: string, sessionId: string): Promise<StoredSessionMetadata | undefined> {
  const result = await readSafeFile(root, metadataPath(root, sessionId), MAX_METADATA_BYTES);
  if (result === undefined) return undefined;
  if (result.truncated) throw new Error(`Session metadata is too large: ${sessionId}`);
  let value: unknown;
  try {
    value = JSON.parse(result.buffer.toString('utf8'));
  } catch {
    throw new Error(`Session metadata contains invalid JSON: ${sessionId}`);
  }
  return parseSessionMetadata(value, sessionId);
}

async function listSessionMetadata(root: string): Promise<StoredSessionMetadata[]> {
  const sessionsDirectory = join(root, '.agentcode', 'sessions');
  const safeDirectory = await findSafeDirectory(root, sessionsDirectory).catch(() => undefined);
  if (safeDirectory === undefined) return [];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(safeDirectory, { encoding: 'utf8', withFileTypes: true });
  } catch {
    return [];
  }
  const metadata = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(META_SUFFIX))
      .map(async (entry) => {
        const sessionId = basename(entry.name, META_SUFFIX);
        try {
          return await readSessionMetadata(root, sessionId);
        } catch {
          return undefined;
        }
      }),
  );
  return metadata.filter((entry): entry is StoredSessionMetadata => entry !== undefined);
}

async function hasSessionLock(root: string, sessionId: string): Promise<boolean> {
  try {
    return await readSafeFile(root, join(root, '.agentcode', 'sessions', `${sessionId}.lock`), 16 * 1024) !== undefined;
  } catch {
    return true;
  }
}

function parseSessionMetadata(value: unknown, expectedId: string): StoredSessionMetadata {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['id'] !== expectedId ||
    (value['name'] !== undefined && typeof value['name'] !== 'string') ||
    typeof value['createdAt'] !== 'number' ||
    !Number.isFinite(value['createdAt']) ||
    typeof value['updatedAt'] !== 'number' ||
    !Number.isFinite(value['updatedAt']) ||
    !Number.isSafeInteger(value['turnCount']) ||
    (value['turnCount'] as number) < 0 ||
    (value['agentMode'] !== 'default' && value['agentMode'] !== 'plan') ||
    !isPermissionMode(value['selectedPermissionMode'])
  ) {
    throw new Error(`Session metadata has an invalid schema: ${expectedId}`);
  }
  return {
    schemaVersion: 1,
    id: expectedId,
    ...(value['name'] !== undefined ? { name: value['name'] } : {}),
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
    turnCount: value['turnCount'] as number,
    agentMode: value['agentMode'],
    selectedPermissionMode: value['selectedPermissionMode'],
  };
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'strict' || value === 'normal' || value === 'auto' || value === 'yolo';
}

function createSessionId(): string {
  const date = new Date();
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${datePart}-${timePart}-${randomBytes(2).toString('hex')}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
