import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ChatMessage as ProviderChatMessage } from '../providers/types.js';
import {
  type FileFingerprint,
  findSafeDirectory,
  readSafeFile,
} from '../shared/safeFs.js';
import type { ChatMessage as SessionChatMessage } from './types.js';
import {
  type ArchivedSessionMessage,
  parseArchivedSessionMessage,
  toProviderMessage,
  toSessionMessage,
} from './archiveSchema.js';

const SESSION_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const MAX_SESSIONS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;

export interface SessionSummary {
  filePath: string;
  sessionId: string;
  messageCount: number;
  lastModified: Date;
}

export interface RestoredSessionSource {
  sessionId: string;
  filePath: string;
  repairOffset?: number;
  expectedFile: FileFingerprint;
}

export interface RestoredSession {
  providerContext: ProviderChatMessage[];
  messages: SessionChatMessage[];
  source?: RestoredSessionSource;
}

interface ParsedRecord {
  archived: ArchivedSessionMessage;
  startOffset: number;
}

interface PendingTools {
  ids: Set<string>;
  validStartIndex: number;
  repairOffset: number;
}

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const sessionsDir = join(cwd, '.agentcode', 'sessions');
  let safeSessionsDir: string | undefined;
  try {
    safeSessionsDir = await findSafeDirectory(cwd, sessionsDir);
  } catch {
    return [];
  }
  if (safeSessionsDir === undefined) return [];

  let entries: Dirent<string>[];
  try {
    entries = await readdir(safeSessionsDir, { encoding: 'utf8', withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<Omit<SessionSummary, 'messageCount'>> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const filePath = join(sessionsDir, entry.name);
    try {
      const info = await lstat(join(safeSessionsDir, entry.name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) continue;
      candidates.push({ filePath, sessionId, lastModified: info.mtime });
    } catch {
      // 单个候选消失时跳过，不影响其余会话。
    }
  }

  const recent = candidates
    .sort((left, right) => right.lastModified.getTime() - left.lastModified.getTime())
    .slice(0, MAX_SESSIONS);
  const summaries = await Promise.all(
    recent.map(async (candidate): Promise<SessionSummary | undefined> => {
      try {
        const result = await readSafeFile(cwd, candidate.filePath, MAX_SESSION_BYTES);
        if (result === undefined || result.truncated) return undefined;
        return { ...candidate, messageCount: parseRecords(result.buffer).length };
      } catch {
        return undefined;
      }
    }),
  );
  return summaries.filter((summary): summary is SessionSummary => summary !== undefined);
}

export async function loadSession(filePath: string, cwd = inferSessionRoot(filePath)): Promise<RestoredSession> {
  const result = await readSafeFile(cwd, filePath, MAX_SESSION_BYTES);
  if (result === undefined) throw new Error(`Session file does not exist: ${filePath}`);
  if (result.truncated) throw new Error(`Session file exceeds ${MAX_SESSION_BYTES} bytes: ${filePath}`);
  const records = parseRecords(result.buffer);
  const { valid, repairOffset } = retainCompleteToolSequences(records);
  const providerContext = buildProviderContext(valid);
  const messages = valid
    .map((record) => toSessionMessage(record.archived))
    .filter((message): message is SessionChatMessage => message !== undefined);
  const sessionId = basename(filePath, '.jsonl');
  const source: RestoredSessionSource = {
    sessionId,
    filePath,
    expectedFile: result.fingerprint,
    ...(repairOffset !== undefined ? { repairOffset } : {}),
  };
  return { providerContext, messages, source };
}

function inferSessionRoot(filePath: string): string {
  const sessionsDir = dirname(filePath);
  const agentcodeDir = dirname(sessionsDir);
  return basename(agentcodeDir) === '.agentcode' ? dirname(agentcodeDir) : sessionsDir;
}

function parseRecords(buffer: Buffer): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const line of splitBufferLines(buffer)) {
    if (line.text.trim().length === 0) {
      continue;
    }
    try {
      const archived = parseArchivedSessionMessage(JSON.parse(line.text));
      if (archived !== undefined) {
        records.push({ archived, startOffset: line.startOffset });
      }
    } catch {
      // 坏 JSON 行仅跳过，不中断后续恢复。
    }
  }
  return records;
}

function retainCompleteToolSequences(records: readonly ParsedRecord[]): {
  valid: ParsedRecord[];
  repairOffset?: number;
} {
  const valid: ParsedRecord[] = [];
  let pending: PendingTools | undefined;

  for (const record of records) {
    const message = record.archived;
    if (pending !== undefined) {
      if (message.role !== 'tool') {
        return { valid: valid.slice(0, pending.validStartIndex), repairOffset: pending.repairOffset };
      }
      if (!pending.ids.delete(message.toolCallId)) {
        continue;
      }
      valid.push(record);
      if (pending.ids.size === 0) {
        pending = undefined;
      }
      continue;
    }

    if (valid.length === 0 && message.role !== 'user') {
      continue;
    }
    if (message.role === 'tool') {
      continue;
    }
    if (message.role === 'assistant' && 'toolCalls' in message) {
      pending = {
        ids: new Set(message.toolCalls.map((call) => call.id)),
        validStartIndex: valid.length,
        repairOffset: record.startOffset,
      };
    }
    valid.push(record);
  }

  if (pending !== undefined) {
    return { valid: valid.slice(0, pending.validStartIndex), repairOffset: pending.repairOffset };
  }
  return { valid };
}

function buildProviderContext(records: readonly ParsedRecord[]): ProviderChatMessage[] {
  const messages: ProviderChatMessage[] = [];
  let previousTimestamp: number | undefined;
  const outstandingToolCalls = new Set<string>();
  const deferredReminders: ProviderChatMessage[] = [];

  for (const record of records) {
    const message = record.archived;
    if (previousTimestamp !== undefined && message._ts - previousTimestamp > DAY_MS) {
      const elapsedHours = Math.ceil((message._ts - previousTimestamp) / HOUR_MS);
      const reminder: ProviderChatMessage = {
        role: 'user',
        content: `[距上次对话已超过 ${elapsedHours} 小时，本段对话发生于 ${formatLocalTime(message._ts)}]`,
      };
      if (outstandingToolCalls.size === 0) {
        messages.push(reminder);
      } else {
        deferredReminders.push(reminder);
      }
    }
    if (outstandingToolCalls.size === 0 && deferredReminders.length > 0) {
      messages.push(...deferredReminders.splice(0));
    }
    messages.push(toProviderMessage(message));

    if (message.role === 'assistant' && 'toolCalls' in message) {
      for (const call of message.toolCalls) outstandingToolCalls.add(call.id);
    } else if (message.role === 'tool') {
      outstandingToolCalls.delete(message.toolCallId);
    }
    previousTimestamp = message._ts;
  }
  messages.push(...deferredReminders);
  return messages;
}

function splitBufferLines(buffer: Buffer): Array<{ text: string; startOffset: number }> {
  const lines: Array<{ text: string; startOffset: number }> = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0x0a) {
      continue;
    }
    const end = index > start && buffer[index - 1] === 0x0d ? index - 1 : index;
    lines.push({ text: buffer.subarray(start, end).toString('utf8'), startOffset: start });
    start = index + 1;
  }
  if (start < buffer.length) {
    lines.push({ text: buffer.subarray(start).toString('utf8'), startOffset: start });
  }
  return lines;
}

function formatLocalTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
