import { createHash, randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  type FileFingerprint,
  atomicWritePrivateFile,
  fingerprintsMatch,
  readSafeFile,
} from '../../shared/safeFs.js';

const MEMORY_DIRECTORY = join('.agentcode', 'memory');
const INDEX_FILE = 'MEMORY.md';
const FILE_MODE = 0o600;
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

export type MemoryScope = 'user' | 'project';

export interface MemoryEntrySummary {
  id: string;
  scope: MemoryScope;
  title: string;
  filename: string;
  summary: string;
  path: string;
}

export interface MemoryStatusSnapshot {
  autoNotesEnabled: boolean;
  counts: { user: number; project: number };
  indexPaths: { user: string; project: string };
  storagePaths: { user: string; project: string };
}

export interface MemoryIndexSnapshot {
  user: readonly MemoryEntrySummary[];
  project: readonly MemoryEntrySummary[];
  status: MemoryStatusSnapshot;
}

export interface MemoryEntryContents extends MemoryEntrySummary {
  frontmatter: string;
  body: string;
  content: string;
  fingerprint: FileFingerprint;
}

export interface MemoryDeleteTarget extends MemoryEntrySummary {
  indexPath: string;
  indexLine: number;
  indexFingerprint: FileFingerprint;
  noteFingerprint: FileFingerprint;
  canonicalPath: string;
  originalIndex: string;
}

export function memoryDeleteFingerprint(target: MemoryDeleteTarget): string {
  return createHash('sha256')
    .update(JSON.stringify({
      scope: target.scope,
      filename: target.filename,
      indexLine: target.indexLine,
      canonicalPath: target.canonicalPath,
      indexFingerprint: target.indexFingerprint,
      noteFingerprint: target.noteFingerprint,
    }))
    .digest('hex');
}

type WriteIndex = typeof atomicWritePrivateFile;
type RenameFile = typeof rename;

export interface MemoryManagerOptions {
  cwd: string;
  homeDir: string;
  autoNotesEnabled?: boolean;
  writeIndex?: WriteIndex;
  renameFile?: RenameFile;
  createNonce?: () => string;
}

export class MemoryTargetChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryTargetChangedError';
  }
}

interface ParsedIndexEntry extends MemoryEntrySummary {
  line: number;
}

interface LoadedIndex {
  scope: MemoryScope;
  root: string;
  directory: string;
  path: string;
  content: string;
  fingerprint?: FileFingerprint;
  entries: ParsedIndexEntry[];
}

export class MemoryManager {
  readonly writeIndex: WriteIndex;
  readonly renameFile: RenameFile;

  private readonly roots: Record<MemoryScope, string>;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryManagerOptions) {
    this.roots = { user: resolve(options.homeDir), project: resolve(options.cwd) };
    this.writeIndex = options.writeIndex ?? atomicWritePrivateFile;
    this.renameFile = options.renameFile ?? rename;
  }

  async list(): Promise<MemoryIndexSnapshot> {
    const [userIndex, projectIndex] = await Promise.all([this.loadIndex('user'), this.loadIndex('project')]);
    const user = userIndex.entries.map(stripIndexLine);
    const project = projectIndex.entries.map(stripIndexLine);
    return {
      user,
      project,
      status: {
        autoNotesEnabled: this.options.autoNotesEnabled ?? false,
        counts: { user: user.length, project: project.length },
        indexPaths: { user: userIndex.path, project: projectIndex.path },
        storagePaths: { user: userIndex.directory, project: projectIndex.directory },
      },
    };
  }

  async read(scope: MemoryScope, entry: string): Promise<MemoryEntryContents> {
    const index = await this.loadIndex(scope);
    const summary = resolveEntry(index.entries, entry);
    const result = await readSafeFile(index.root, summary.path, MAX_NOTE_BYTES);
    if (result === undefined) throw new Error(`Memory entry file does not exist: ${summary.filename}`);
    if (result.truncated) throw new Error(`Memory entry exceeds ${MAX_NOTE_BYTES} bytes: ${summary.filename}`);
    const content = result.buffer.toString('utf8');
    const parsed = parseFrontmatter(content);
    return {
      ...stripIndexLine(summary),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      content,
      fingerprint: result.fingerprint,
    };
  }

  async prepareDelete(scope: MemoryScope, entry: string): Promise<MemoryDeleteTarget> {
    const index = await this.loadIndex(scope);
    if (index.fingerprint === undefined) throw new Error(`Memory index does not exist for scope: ${scope}`);
    const summary = resolveEntry(index.entries, entry);
    const note = await readSafeFile(index.root, summary.path, MAX_NOTE_BYTES);
    if (note === undefined) throw new Error(`Memory entry file does not exist: ${summary.filename}`);
    if (note.truncated) throw new Error(`Memory entry exceeds ${MAX_NOTE_BYTES} bytes: ${summary.filename}`);
    return {
      ...stripIndexLine(summary),
      indexPath: index.path,
      indexLine: summary.line,
      indexFingerprint: index.fingerprint,
      noteFingerprint: note.fingerprint,
      canonicalPath: note.canonicalPath,
      originalIndex: index.content,
    };
  }

  delete(target: MemoryDeleteTarget): Promise<void> {
    return this.serialize(async () => {
      const index = await this.loadIndex(target.scope);
      if (
        index.fingerprint === undefined ||
        !fingerprintsMatch(index.fingerprint, target.indexFingerprint) ||
        index.content !== target.originalIndex
      ) {
        throw new MemoryTargetChangedError(`Memory index changed before confirmation: ${target.indexPath}`);
      }
      const currentEntry = index.entries.find(
        (entry) => entry.line === target.indexLine && entry.filename === target.filename,
      );
      if (currentEntry === undefined) {
        throw new MemoryTargetChangedError(`Memory entry changed before confirmation: ${target.filename}`);
      }
      const note = await readSafeFile(index.root, currentEntry.path, MAX_NOTE_BYTES);
      if (
        note === undefined ||
        note.canonicalPath !== target.canonicalPath ||
        !fingerprintsMatch(note.fingerprint, target.noteFingerprint)
      ) {
        throw new MemoryTargetChangedError(`Memory file changed before confirmation: ${target.filename}`);
      }

      const nextIndex = removeIndexLine(index.content, target.indexLine);
      const tombstone = join(index.directory, `.${basename(target.filename)}.${(this.options.createNonce ?? randomUUID)()}.delete`);
      let moved = false;
      let indexWritten = false;
      try {
        await this.renameFile(currentEntry.path, tombstone);
        moved = true;
        const movedNote = await readSafeFile(index.root, tombstone, MAX_NOTE_BYTES);
        if (movedNote === undefined || movedNote.truncated || !fingerprintsMatch(movedNote.fingerprint, target.noteFingerprint)) {
          throw new MemoryTargetChangedError(`Memory file changed while it was being moved: ${target.filename}`);
        }
        await this.writeIndex(index.root, index.path, nextIndex, FILE_MODE);
        indexWritten = true;
        const deleteCandidate = await readSafeFile(index.root, tombstone, MAX_NOTE_BYTES);
        if (
          deleteCandidate === undefined ||
          deleteCandidate.truncated ||
          !fingerprintsMatch(deleteCandidate.fingerprint, target.noteFingerprint)
        ) {
          throw new MemoryTargetChangedError(`Memory tombstone changed before deletion: ${target.filename}`);
        }
        await rm(tombstone);
        moved = false;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (indexWritten) {
          try {
            await this.writeIndex(index.root, index.path, index.content, FILE_MODE);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (moved) {
          try {
            const replacement = await readSafeFile(index.root, currentEntry.path, 1);
            if (replacement !== undefined) {
              throw new MemoryTargetChangedError(
                `Memory path was recreated during rollback; preserved tombstone at ${tombstone}`,
              );
            }
            await this.renameFile(tombstone, currentEntry.path);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], `Memory delete rollback failed for ${target.filename}`);
        }
        throw error;
      }
    });
  }

  private async loadIndex(scope: MemoryScope): Promise<LoadedIndex> {
    const root = this.roots[scope];
    const directory = join(root, MEMORY_DIRECTORY);
    const path = join(directory, INDEX_FILE);
    const result = await readSafeFile(root, path, MAX_INDEX_BYTES);
    if (result === undefined) return { scope, root, directory, path, content: '', entries: [] };
    if (result.truncated) throw new Error(`Memory index exceeds ${MAX_INDEX_BYTES} bytes: ${path}`);
    const content = result.buffer.toString('utf8');
    return {
      scope,
      root,
      directory,
      path,
      content,
      fingerprint: result.fingerprint,
      entries: parseIndex(scope, directory, content),
    };
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

function parseIndex(scope: MemoryScope, directory: string, content: string): ParsedIndexEntry[] {
  const entries: ParsedIndexEntry[] = [];
  for (const [line, raw] of content.split(/\r?\n/u).entries()) {
    const match = /^- \[(.*)\]\((.+\.md)\) — (.*)$/u.exec(raw.trim());
    if (match === null) continue;
    let filename: string;
    try {
      filename = normalizeMemoryFilename(match[2]!);
    } catch {
      continue;
    }
    entries.push({
      id: filename,
      scope,
      title: match[1]!,
      filename,
      summary: match[3]!,
      path: join(directory, filename),
      line,
    });
  }
  return entries;
}

function resolveEntry(entries: readonly ParsedIndexEntry[], selector: string): ParsedIndexEntry {
  const filename = normalizeMemoryFilename(selector);
  const matches = entries.filter((entry) => entry.id === filename || entry.filename === filename);
  if (matches.length === 0) throw new Error(`Memory entry is not indexed: ${filename}`);
  if (matches.length > 1) throw new MemoryTargetChangedError(`Memory entry is ambiguous: ${filename}`);
  return matches[0]!;
}

function normalizeMemoryFilename(filename: string): string {
  const trimmed = filename.trim();
  const stem = trimmed.toLowerCase().endsWith('.md') ? trimmed.slice(0, -3) : trimmed;
  const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(stem) ||
    stem.includes('..') ||
    stem.endsWith('.') ||
    windowsReserved.test(stem)
  ) {
    throw new Error(`Unsafe memory filename: ${filename}`);
  }
  const normalized = `${stem}.md`;
  if (normalized.toLocaleLowerCase() === INDEX_FILE.toLocaleLowerCase()) {
    throw new Error(`Unsafe memory filename: ${filename}`);
  }
  return normalized;
}

function stripIndexLine(entry: ParsedIndexEntry): MemoryEntrySummary {
  return {
    id: entry.id,
    scope: entry.scope,
    title: entry.title,
    filename: entry.filename,
    summary: entry.summary,
    path: entry.path,
  };
}

function parseFrontmatter(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { frontmatter: '', body: normalized.trim() };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { frontmatter: '', body: normalized.trim() };
  return {
    frontmatter: normalized.slice(4, end).trim(),
    body: normalized.slice(end + '\n---\n'.length).trim(),
  };
}

function removeIndexLine(content: string, lineToRemove: number): string {
  const hasTrailingNewline = /\r?\n$/u.test(content);
  const lines = content.split(/\r?\n/u);
  if (hasTrailingNewline) lines.pop();
  lines.splice(lineToRemove, 1);
  const joined = lines.join('\n');
  return hasTrailingNewline && joined.length > 0 ? `${joined}\n` : joined;
}
