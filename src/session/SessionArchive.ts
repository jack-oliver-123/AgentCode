import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ChatMessage as ProviderChatMessage } from '../providers/types.js';
import { createId } from '../shared/ids.js';
import {
  type FileFingerprint,
  fingerprintsMatch,
  openSafeFileForUpdate,
} from '../shared/safeFs.js';
import { type ArchivedSessionMessage, cloneProviderMessage } from './archiveSchema.js';

const FILE_MODE = 0o600;
const SESSION_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export interface SessionArchiveResumeOptions {
  sessionId: string;
  repairOffset?: number;
  expectedFile?: FileFingerprint;
}

export interface SessionArchiveOptions {
  sessionsDir: string;
  resume?: SessionArchiveResumeOptions;
  now?: () => number;
  createUiId?: (author: 'user' | 'agent') => string;
  randomHex?: () => string;
}

export interface SessionArchivePort {
  append(messages: readonly ProviderChatMessage[]): Promise<void>;
}

export class SessionArchive implements SessionArchivePort {
  readonly sessionId: string;
  readonly filePath: string;

  private readonly sessionsDir: string;
  private readonly storageRoot: string;
  private readonly now: () => number;
  private readonly createUiId: (author: 'user' | 'agent') => string;
  private repairOffset: number | undefined;
  private expectedFile: FileFingerprint | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: SessionArchiveOptions) {
    this.sessionsDir = resolve(options.sessionsDir);
    this.storageRoot = dirname(dirname(this.sessionsDir));
    this.now = options.now ?? Date.now;
    this.createUiId = options.createUiId ?? ((author) => createId(author === 'user' ? 'user' : 'assistant'));

    const sessionId = options.resume?.sessionId ?? createSessionId(this.now(), options.randomHex?.() ?? randomBytes(2).toString('hex'));
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    if (
      options.resume?.repairOffset !== undefined &&
      (!Number.isSafeInteger(options.resume.repairOffset) || options.resume.repairOffset < 0)
    ) {
      throw new RangeError('repairOffset must be a non-negative safe integer.');
    }

    this.sessionId = sessionId;
    this.filePath = join(this.sessionsDir, `${sessionId}.jsonl`);
    this.repairOffset = options.resume?.repairOffset;
    this.expectedFile = options.resume?.expectedFile;
    if (this.repairOffset !== undefined && this.expectedFile === undefined) {
      throw new Error('A repair offset requires the restored file fingerprint.');
    }
  }

  append(messages: readonly ProviderChatMessage[]): Promise<void> {
    const snapshot = messages.map(cloneProviderMessage);
    const operation = this.pending.then(() => this.appendOnce(snapshot));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async appendOnce(messages: readonly ProviderChatMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    try {
      const opened = await openSafeFileForUpdate(
        this.storageRoot,
        this.filePath,
        FILE_MODE,
        this.repairOffset === undefined,
      );
      const { handle } = opened;
      try {
        if (this.repairOffset !== undefined) {
          if (
            this.expectedFile === undefined ||
            !fingerprintsMatch(this.expectedFile, opened.fingerprint) ||
            this.repairOffset > opened.fingerprint.size
          ) {
            // 指纹不匹配说明恢复后磁盘上又新增了消息（其他进程/会话已续写）。
            // 此时绝不用陈旧 offset 截断，而是放弃本轮追加：当前 turn 不会落盘，
            // 坏尾由下次 --resume 重新探测修复。这是有意的数据取舍——宁可本轮归档
            // 缺失，也不能覆盖其他进程已写入的有效消息。
            throw new Error('Session archive changed after restore; refusing to apply a stale repair offset.');
          }
          await handle.truncate(this.repairOffset);
          this.repairOffset = undefined;
          this.expectedFile = undefined;
        }

        const current = await handle.stat();
        const needsLeadingNewline = await fileNeedsLeadingNewline(handle, current.size);
        const archived = messages.map((message) => this.archiveMessage(message));
        const body = `${needsLeadingNewline ? '\n' : ''}${archived.map((message) => JSON.stringify(message)).join('\n')}\n`;
        await writeAtEnd(handle, Buffer.from(body, 'utf8'), current.size);
        await handle.sync();
        if (process.platform !== 'win32') await handle.chmod(FILE_MODE);
      } finally {
        await handle.close();
      }
    } catch (error) {
      console.warn(`[SessionArchive] 会话存档失败: ${this.filePath}`, error);
    }
  }

  private archiveMessage(message: ProviderChatMessage): ArchivedSessionMessage {
    const timestamp = this.now();
    if (message.role === 'tool') {
      return { ...message, _ts: timestamp };
    }
    if ('toolCalls' in message) {
      return { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })), _ts: timestamp };
    }
    const author = message.role === 'user' ? 'user' : 'agent';
    return {
      ...message,
      _ts: timestamp,
      _ui: { id: this.createUiId(author), createdAt: timestamp, author },
    };
  }
}

async function fileNeedsLeadingNewline(handle: FileHandle, size: number): Promise<boolean> {
  if (size === 0) {
    return false;
  }

  const lastByte = Buffer.allocUnsafe(1);
  await handle.read(lastByte, 0, 1, size - 1);
  return lastByte[0] !== 0x0a;
}

async function writeAtEnd(handle: FileHandle, buffer: Buffer, initialPosition: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, initialPosition + offset);
    if (result.bytesWritten === 0) throw new Error('Session archive write made no progress.');
    offset += result.bytesWritten;
  }
}

function createSessionId(timestamp: number, randomHex: string): string {
  if (!/^[0-9a-f]{4}$/i.test(randomHex)) {
    throw new Error('Session random suffix must contain exactly four hexadecimal characters.');
  }
  const date = new Date(timestamp);
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${datePart}-${timePart}-${randomHex.toLowerCase()}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
