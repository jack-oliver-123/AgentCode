import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';

import type { ChatModelProvider, ProviderRequest } from '../providers/types.js';
import { atomicWritePrivateFile } from '../shared/safeFs.js';
import { loadMemoryIndexes } from '../system-prompt/loadMemoryIndex.js';

const CONFIG_DIRECTORY = '.agentcode';
const MEMORY_DIRECTORY = 'memory';
const INDEX_FILE = 'MEMORY.md';
const FILE_MODE = 0o600;
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25 * 1024;
const MAX_PRUNE_ATTEMPTS = 3;
const MAX_OPERATIONS = 50;
const MAX_NOTE_BODY_LENGTH = 256 * 1024;

const NOTE_OPERATION_SCHEMA = z
  .object({
    op: z.enum(['add', 'update', 'delete']),
    level: z.enum(['user', 'project']),
    title: z.string().min(1).max(500),
    filename: z.string().min(1).max(200),
    summary: z.string().max(2000),
    type: z.enum(['user', 'feedback', 'project', 'reference']),
    body: z.string().max(MAX_NOTE_BODY_LENGTH),
  })
  .strict();
const PRUNE_SELECTION_SCHEMA = z
  .object({
    level: z.enum(['user', 'project']),
    filename: z.string().min(1).max(200),
  })
  .strict();

type NoteOperation = z.infer<typeof NOTE_OPERATION_SCHEMA>;
type MemoryLevel = NoteOperation['level'];

interface IndexEntry {
  title: string;
  filename: string;
  summary: string;
}

export interface AutoNoteWriterOptions {
  provider: ChatModelProvider;
  model: string;
  timeoutMs: number;
  cwd: string;
  homeDir: string;
}

export interface AutoNoteUpdateParams {
  userText: string;
  assistantText: string;
  completionTokens: number;
}

export interface AutoNoteWriterPort {
  maybeUpdate(params: AutoNoteUpdateParams): Promise<void>;
}

export class AutoNoteWriter implements AutoNoteWriterPort {
  private readonly provider: ChatModelProvider;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private readonly homeDir: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: AutoNoteWriterOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.cwd = resolve(options.cwd);
    this.homeDir = resolve(options.homeDir);
  }

  maybeUpdate(params: AutoNoteUpdateParams): Promise<void> {
    if (!shouldTriggerAutoNote(params)) {
      return Promise.resolve();
    }

    const snapshot = { ...params };
    const operation = this.pending.then(async () => {
      try {
        await this.updateOnce(snapshot);
      } catch (error) {
        console.warn('[AutoNoteWriter] 自动笔记更新失败', error);
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async updateOnce(params: AutoNoteUpdateParams): Promise<void> {
    const indexes = await loadMemoryIndexes(this.cwd, this.homeDir);
    const response = await this.requestText(buildOperationPrompt(params, indexes));
    if (response === undefined) {
      return;
    }
    const operations = parseOperations(response);
    if (operations.length === 0) {
      console.warn('[AutoNoteWriter] LLM 返回的笔记操作不是有效 JSON 数组');
      return;
    }

    const states: Record<MemoryLevel, Map<string, IndexEntry>> = {
      user: parseIndex(indexes.user),
      project: parseIndex(indexes.project),
    };
    const dirty = new Set<MemoryLevel>();

    for (const operation of operations) {
      try {
        const filename = normalizeNoteFilename(operation.filename);
        if (operation.op === 'delete') {
          states[operation.level].delete(filename);
          dirty.add(operation.level);
          continue;
        }

        const memoryDir = this.memoryDir(operation.level);
        const notePath = join(memoryDir, filename);
        await atomicWritePrivateFile(this.memoryRoot(operation.level), notePath, createNoteContent(operation, filename), FILE_MODE);
        states[operation.level].set(filename, {
          title: singleLine(operation.title),
          filename,
          summary: singleLine(operation.summary),
        });
        dirty.add(operation.level);
      } catch (error) {
        console.warn(`[AutoNoteWriter] 跳过无效的 ${operation.level} 笔记操作`, error);
      }
    }

    for (const level of dirty) {
      if (!(await this.pruneIndex(level, states[level]))) continue;
      const memoryDir = this.memoryDir(level);
      const indexPath = join(memoryDir, INDEX_FILE);
      await atomicWritePrivateFile(this.memoryRoot(level), indexPath, formatIndex(states[level]), FILE_MODE);
    }
  }

  private async pruneIndex(level: MemoryLevel, entries: Map<string, IndexEntry>): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_PRUNE_ATTEMPTS && indexExceedsLimit(formatIndex(entries)); attempt++) {
      const response = await this.requestText(buildPrunePrompt(level, formatIndex(entries)));
      if (response === undefined) {
        break;
      }
      const selection = parseJsonResponse(response, PRUNE_SELECTION_SCHEMA);
      if (selection === undefined || selection.level !== level) {
        console.warn(`[AutoNoteWriter] 第 ${attempt + 1} 次索引裁剪返回无效选择`);
        continue;
      }
      try {
        const filename = normalizeNoteFilename(selection.filename);
        if (!entries.delete(filename)) {
          console.warn(`[AutoNoteWriter] 索引裁剪选择了不存在的条目: ${filename}`);
        }
      } catch (error) {
        console.warn('[AutoNoteWriter] 索引裁剪文件名无效', error);
      }
    }

    if (indexExceedsLimit(formatIndex(entries))) {
      console.warn(`[AutoNoteWriter] ${level} MEMORY.md 在 3 次裁剪后仍超过限制`);
      return false;
    }
    return true;
  }

  private async requestText(prompt: string): Promise<string | undefined> {
    const request: ProviderRequest = {
      model: this.model,
      system: '你是 AgentCode 的记忆维护器。只返回请求中指定的 JSON，不要添加解释。',
      messages: [{ role: 'user', content: prompt }],
      thinking: { enabled: false },
      tools: [],
      toolChoice: 'none',
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    let text = '';
    let completed = false;
    try {
      for await (const event of this.provider.stream(request)) {
        if (event.type === 'content.delta') {
          text += event.delta;
        } else if (event.type === 'response.error') {
          console.warn('[AutoNoteWriter] LLM 请求失败', event.error);
          return undefined;
        } else if (event.type === 'response.complete') {
          completed = true;
          break;
        }
      }
    } catch (error) {
      console.warn('[AutoNoteWriter] LLM 请求异常', error);
      return undefined;
    }

    if (!completed) {
      console.warn('[AutoNoteWriter] LLM 响应未正常完成');
      return undefined;
    }
    return text;
  }

  private memoryDir(level: MemoryLevel): string {
    return join(this.memoryRoot(level), CONFIG_DIRECTORY, MEMORY_DIRECTORY);
  }

  private memoryRoot(level: MemoryLevel): string {
    return level === 'user' ? this.homeDir : this.cwd;
  }
}

export function shouldTriggerAutoNote(params: AutoNoteUpdateParams): boolean {
  const hasPreferenceSignal =
    /不要|记住|以后|别再/.test(params.userText) || /\b(?:don['’]t|remember|always|never|stop)\b/i.test(params.userText);
  const hasFencedCode = params.assistantText.includes('```');
  return hasPreferenceSignal || (params.completionTokens > 200 && hasFencedCode);
}

function buildOperationPrompt(
  params: AutoNoteUpdateParams,
  indexes: { user: string; project: string },
): string {
  return `根据本轮对话和现有索引生成记忆操作。

用户消息：
${params.userText}

Assistant 回复：
${params.assistantText}

用户级 MEMORY.md：
${indexes.user}

项目级 MEMORY.md：
${indexes.project}

只返回 JSON 数组，每项必须包含：
{"op":"add|update|delete","level":"user|project","title":"string(<=500)","filename":"string(<=200，仅字母数字._-)","summary":"string(<=2000)","type":"user|feedback|project|reference","body":"string(<=256KB)"}`;
}

function buildPrunePrompt(level: MemoryLevel, index: string): string {
  return `下面的 ${level} MEMORY.md 超过限制。选择最不重要的一条，只返回 JSON 对象：
{"level":"${level}","filename":"条目文件名.md"}

索引：
${index}`;
}

function parseJsonResponse<T>(text: string, schema: z.ZodType<T>): T | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    const result = schema.safeParse(JSON.parse(candidate));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 逐元素解析 LLM 返回的操作数组。任意单条非法（字段缺失、body 过大、枚举越界等）
 * 只跳过该条并记录 warn，不影响其余合法操作，避免一条坏数据让整批丢失。
 */
function parseOperations(text: string): NoteOperation[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const operations: NoteOperation[] = [];
  for (const [index, item] of raw.entries()) {
    const result = NOTE_OPERATION_SCHEMA.safeParse(item);
    if (result.success) {
      if (operations.length >= MAX_OPERATIONS) {
        console.warn(`[AutoNoteWriter] 超过 ${MAX_OPERATIONS} 条操作上限，丢弃后续条目`);
        break;
      }
      operations.push(result.data);
    } else {
      console.warn(`[AutoNoteWriter] 跳过第 ${index + 1} 条无效笔记操作`, result.error);
    }
  }
  return operations;
}

function createNoteContent(operation: NoteOperation, filename: string): string {
  const name = slugify(filename.slice(0, -'.md'.length));
  const frontmatter = stringify({
    name,
    description: singleLine(operation.summary),
    metadata: { type: operation.type },
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${operation.body.trim()}\n`;
}

function parseIndex(content: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^- \[(.*)\]\((.+\.md)\) — (.*)$/.exec(line.trim());
    if (match === null) continue;
    try {
      const filename = normalizeNoteFilename(match[2]!);
      entries.set(filename, { title: match[1]!, filename, summary: match[3]! });
    } catch {
      // 非法索引路径不参与重建，避免让既有脏数据突破 memory 目录。
    }
  }
  return entries;
}

function formatIndex(entries: Map<string, IndexEntry>): string {
  return [...entries.values()]
    .map((entry) => `- [${escapeIndexTitle(entry.title)}](${entry.filename}) — ${singleLine(entry.summary)}`)
    .join('\n');
}

function indexExceedsLimit(content: string): boolean {
  const lineCount = content.length === 0 ? 0 : content.split('\n').length;
  return lineCount > MAX_INDEX_LINES || Buffer.byteLength(content, 'utf8') > MAX_INDEX_BYTES;
}

function normalizeNoteFilename(filename: string): string {
  const trimmed = filename.trim();
  const stem = trimmed.toLowerCase().endsWith('.md') ? trimmed.slice(0, -3) : trimmed;
  const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stem) ||
    stem.includes('..') ||
    stem.endsWith('.') ||
    windowsReserved.test(stem)
  ) {
    throw new Error(`Unsafe note filename: ${filename}`);
  }
  const normalized = `${stem}.md`;
  if (normalized.toLowerCase() === INDEX_FILE.toLowerCase()) {
    throw new Error(`${INDEX_FILE} is reserved for the memory index.`);
  }
  return normalized;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function escapeIndexTitle(value: string): string {
  return singleLine(value).replace(/]/g, '\\]');
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'note';
}
