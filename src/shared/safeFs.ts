import { constants, type Stats } from 'node:fs';
import {
  type FileHandle,
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export interface SafeReadResult {
  buffer: Buffer;
  truncated: boolean;
  canonicalPath: string;
  fingerprint: FileFingerprint;
}

export interface SafeUpdateHandle {
  handle: FileHandle;
  fingerprint: FileFingerprint;
}

export class SafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafePathError';
  }
}

export async function readSafeFile(
  root: string,
  filePath: string,
  maxBytes: number,
): Promise<SafeReadResult | undefined> {
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(filePath);
  assertPathWithin(lexicalRoot, lexicalTarget);

  try {
    await assertNoLinkedAncestors(lexicalRoot, lexicalTarget);
    const before = await lstat(lexicalTarget);
    validateRegularSingleLink(before, lexicalTarget);
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
    assertPathWithin(canonicalRoot, canonicalTarget);

    const handle = await open(lexicalTarget, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat();
      validateRegularSingleLink(opened, lexicalTarget);
      assertSameIdentity(before, opened, lexicalTarget);
      const confirmedTarget = await realpath(lexicalTarget);
      if (comparablePath(confirmedTarget) !== comparablePath(canonicalTarget)) {
        throw new SafePathError(`File changed during safe open: ${lexicalTarget}`);
      }

      const readLength = Math.min(opened.size, maxBytes);
      const buffer = Buffer.alloc(readLength);
      let offset = 0;
      while (offset < readLength) {
        const result = await handle.read(buffer, offset, readLength - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new SafePathError(`File changed while being read: ${lexicalTarget}`);
      }
      return {
        buffer: offset === buffer.length ? buffer : buffer.subarray(0, offset),
        truncated: opened.size > maxBytes,
        canonicalPath: canonicalTarget,
        fingerprint: toFileFingerprint(after),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function ensurePrivateDirectory(root: string, directory: string, mode: number): Promise<string> {
  const lexicalRoot = resolve(root);
  const lexicalDirectory = resolve(directory);
  assertPathWithin(lexicalRoot, lexicalDirectory);
  const canonicalRoot = await realpath(lexicalRoot);
  const segments = relative(lexicalRoot, lexicalDirectory).split(sep).filter(Boolean);
  let current = canonicalRoot;

  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new SafePathError(`Unsafe directory component: ${current}`);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      try {
        await mkdir(current, { mode });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new SafePathError(`Unsafe directory component: ${current}`);
      }
    }
  }

  const canonicalDirectory = await realpath(current);
  assertPathWithin(canonicalRoot, canonicalDirectory);
  if (process.platform !== 'win32') await chmod(canonicalDirectory, mode);
  return canonicalDirectory;
}

export async function findSafeDirectory(root: string, directory: string): Promise<string | undefined> {
  const lexicalRoot = resolve(root);
  const lexicalDirectory = resolve(directory);
  assertPathWithin(lexicalRoot, lexicalDirectory);
  try {
    await assertNoLinkedAncestors(lexicalRoot, lexicalDirectory);
    const info = await lstat(lexicalDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SafePathError(`Unsafe directory: ${lexicalDirectory}`);
    }
    const [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(lexicalRoot), realpath(lexicalDirectory)]);
    assertPathWithin(canonicalRoot, canonicalDirectory);
    return canonicalDirectory;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function openSafeFileForUpdate(
  root: string,
  filePath: string,
  mode: number,
  append = true,
): Promise<SafeUpdateHandle> {
  const canonicalDirectory = await ensurePrivateDirectory(root, dirname(filePath), 0o700);
  const targetPath = join(canonicalDirectory, basename(filePath));
  let before: Stats | undefined;
  try {
    before = await lstat(targetPath);
    validateRegularSingleLink(before, targetPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  const handle = await open(
    targetPath,
    constants.O_RDWR | constants.O_CREAT | NO_FOLLOW | (append ? constants.O_APPEND : 0),
    mode,
  );
  try {
    const opened = await handle.stat();
    validateRegularSingleLink(opened, targetPath);
    if (before !== undefined) assertSameIdentity(before, opened, targetPath);
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(resolve(root)), realpath(targetPath)]);
    assertPathWithin(canonicalRoot, canonicalTarget);
    return { handle, fingerprint: toFileFingerprint(opened) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function atomicWritePrivateFile(
  root: string,
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const canonicalDirectory = await ensurePrivateDirectory(root, dirname(filePath), 0o700);
  const targetPath = join(canonicalDirectory, basename(filePath));
  const tempPath = join(
    canonicalDirectory,
    `.${basename(filePath)}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, targetPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function toFileFingerprint(stats: Stats): FileFingerprint {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
  };
}

export function fingerprintsMatch(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

export function assertPathWithin(root: string, target: string): void {
  const fromRoot = relative(resolve(root), resolve(target));
  if (fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))) {
    return;
  }
  throw new SafePathError(`Path "${target}" is outside allowed root "${root}".`);
}

async function assertNoLinkedAncestors(root: string, target: string): Promise<void> {
  const fromRoot = relative(resolve(root), resolve(target));
  let current = resolve(root);
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new SafePathError(`Symbolic link is not allowed in safe path: ${current}`);
    }
  }
}

function validateRegularSingleLink(stats: Stats, filePath: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SafePathError(`Path is not a safe regular file: ${filePath}`);
  }
  if (stats.nlink !== 1) {
    throw new SafePathError(`Hard-linked files are not allowed: ${filePath}`);
  }
}

function assertSameIdentity(expected: Stats, actual: Stats, filePath: string): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new SafePathError(`File identity changed during open: ${filePath}`);
  }
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
