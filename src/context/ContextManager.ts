import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Buffer } from 'node:buffer';

import type { ChatModelProvider, ChatMessage, ProviderToolResultMessage } from '../providers/types.js';
import { AgentCodeError, type PublicError } from '../shared/errors.js';
import {
  NORMAL_MARGIN,
  countSummaryTurns,
  createFileRecoveryMessage,
  createSkillRecoveryMessage,
  createSummaryMessages,
  dropOldestTurns,
  finalizeSummary,
  selectCompactionLevel,
  splitCompleteTurns,
  type CompactionLevel,
  type CompactionRequest,
  type CompactionResult,
  type CompleteTurn,
  type SkillDefinitionSnapshot,
  type SkillContextSource,
} from './compaction.js';

const DEFAULT_FORCE_MARGIN = 5_000;
const DEFAULT_EMERGENCY_MARGIN = 2_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_RECENT_FILES_PER_SOURCE = 50;
const MAX_FILE_RECOVERY_PATHS = 5;
const SKILL_RECOVERY_CHAR_BUDGET = 25_000 * 4;

const FILE_ACCESS_SOURCES = ['read_file', 'search_code', 'glob_files'] as const;
type FileAccessSource = (typeof FILE_ACCESS_SOURCES)[number];

interface FileAccessRecord {
  path: string;
  source: FileAccessSource;
  sequence: number;
}

const EMPTY_SKILL_CONTEXT_SOURCE: SkillContextSource = {
  async getUsedSkillDefinitions() {
    return [];
  },
};

const SUMMARY_SYSTEM_PROMPT = [
  '你是精确的会话历史摘要器。禁止调用任何工具，也不得捏造历史中未出现的事实。',
  '必须在同一次响应中依次完成两个阶段：先在 <analysis> 标签中整理草稿，再在 <summary> 标签中输出正式摘要。',
  '草稿需要梳理时间顺序、冲突、错误和修复、当前工作、待办与下一步。',
  '正式摘要必须严格使用指令给出的九个二级标题，标题、顺序和数量都不能改变。',
  '第 6 节只能放指令给出的唯一占位符，不要自行复制、改写或概括用户消息。',
  '只输出一个 <summary> 块；第 8 节必须最详细。',
].join('\n');

const SUMMARY_INSTRUCTION = [
  '请根据以上会话历史，在同一次响应中严格输出以下两阶段结构：',
  '<analysis>',
  '整理草稿：按时间顺序核对请求、技术点、文件与代码、错误和修复、当前工作、待办及下一步。',
  '</analysis>',
  '<summary>',
  '## 1. 主要请求和意图',
  '用户到底想做什么',
  '',
  '## 2. 关键技术概念',
  '讨论过的重要技术点',
  '',
  '## 3. 文件和代码段',
  '涉及哪些文件；只保留历史中确实出现过的关键代码片段',
  '',
  '## 4. 错误和修复',
  '遇到了什么错误，如何解决',
  '',
  '## 5. 问题解决过程',
  '解决问题的思路和方法',
  '',
  '## 6. 所有用户消息',
  '{{ALL_USER_MESSAGES_VERBATIM}}',
  '',
  '## 7. 待办任务',
  '尚未完成的事项',
  '',
  '## 8. 当前工作',
  '最近正在做什么；第 8 节必须最详细',
  '',
  '## 9. 可能的下一步',
  '接下来计划做什么',
  '</summary>',
].join('\n');

type SummaryAttemptResult = { kind: 'success'; summary: string } | { kind: 'prompt_too_long' } | { kind: 'failure' };

type SummaryFallbackResult =
  | { kind: 'success'; summary: string; attempts: number }
  | { kind: 'failure'; attempts: number };

export interface ContextManagerOptions {
  /** 模型上下文窗口大小（tokens） */
  contextWindow: number;
  /** 单条工具结果卸载阈值（字节），默认 8192 */
  offloadThresholdBytes: number;
  /** 每轮工具结果总卸载阈值（字节），默认 32768 */
  turnOffloadThresholdBytes: number;
  /** 卸载文件缓存目录（绝对路径） */
  cacheDir: string;
  /** LLM 摘要调用超时（ms） */
  timeoutMs: number;
  /** 强制压缩距上下文窗口的 token 余量，默认 5000 */
  forceMargin?: number;
  /** 紧急压缩距上下文窗口的 token 余量，默认 2000 */
  emergencyMargin?: number;
  /** 已使用 Skill 定义的可注入来源；T3 接入恢复消息 */
  skillContextSource?: SkillContextSource;
  /**
   * 可注入的文件写入函数，用于测试。
   * 默认使用 node:fs/promises writeFile。
   */
  _writeFile?: (path: string, data: string, encoding: string) => Promise<void>;
}

export class ContextManager {
  private readonly provider: ChatModelProvider;
  private readonly model: string;
  private readonly options: ContextManagerOptions;
  private readonly forceMargin: number;
  private readonly emergencyMargin: number;
  private readonly skillContextSource: SkillContextSource;

  /** F1：上次已知的累计 prompt token 数 */
  private _lastKnownTotalPromptTokens = 0;
  /** F1：自上次 token 汇报后追加的字符数 */
  private _pendingChars = 0;

  /** F9：连续自动摘要失败次数 */
  private _consecutiveSummaryFailures = 0;
  /** 上一次成功压缩生成的合成前缀长度。 */
  private _compactedPrefixLength = 0;
  /** 文件访问账本只保存规范化路径、来源和最近访问顺序。 */
  private _fileAccessSequence = 0;
  private readonly recentFileAccesses: FileAccessRecord[] = [];

  constructor(provider: ChatModelProvider, model: string, options: ContextManagerOptions) {
    this.provider = provider;
    this.model = model;
    this.options = options;
    this.forceMargin = options.forceMargin ?? DEFAULT_FORCE_MARGIN;
    this.emergencyMargin = options.emergencyMargin ?? DEFAULT_EMERGENCY_MARGIN;
    this.skillContextSource = options.skillContextSource ?? EMPTY_SKILL_CONTEXT_SOURCE;

    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs 必须是 1 到 ${MAX_TIMEOUT_MS} 之间的整数`);
    }

    if (!(NORMAL_MARGIN > this.forceMargin && this.forceMargin > this.emergencyMargin && this.emergencyMargin >= 0)) {
      throw new RangeError('压缩水位必须满足 13000 > forceMargin > emergencyMargin >= 0');
    }
  }

  // ─────────────────────────────────────────────
  // F1：token 估算
  // ─────────────────────────────────────────────

  /**
   * 接收 AgentLoop token.usage 事件中的累计 totalPromptTokens。
   * 重置 pendingChars，以此为新的估算基准。
   */
  onTokenUsage(totalPromptTokens: number): void {
    this._lastKnownTotalPromptTokens = totalPromptTokens;
    this._pendingChars = 0;
  }

  /** 向 providerContext 追加消息后调用，并观察尚未卸载的结构化工具结果。 */
  onMessagesAppended(messages: readonly ChatMessage[]): void {
    this._pendingChars += messages.reduce((sum, message) => sum + message.content.length, 0);
    this.recordFileAccesses(messages);
  }

  /**
   * 当前 token 估算值：已知基准 + 待处理字符数 / 4（向上取整）。
   */
  get estimated(): number {
    return this._lastKnownTotalPromptTokens + Math.ceil(this._pendingChars / 4);
  }

  /**
   * F5：连续失败次数 >= 3 时熔断，阻止自动触发。
   */
  get circuitOpen(): boolean {
    return this._consecutiveSummaryFailures >= 3;
  }

  /**
   * 模型上下文窗口大小（tokens），供 Controller 计算水位阈值。
   */
  get contextWindow(): number {
    return this.options.contextWindow;
  }

  // ─────────────────────────────────────────────
  // F2：工具结果卸载（T3 实现）
  // ─────────────────────────────────────────────

  async offloadToolResults(messages: ChatMessage[]): Promise<void> {
    // 确保缓存目录存在
    await mkdir(this.options.cacheDir, { recursive: true });

    const { offloadThresholdBytes, turnOffloadThresholdBytes, cacheDir } = this.options;

    // 按 role:'user' 划分 turn 边界，找出每个 turn 的消息范围
    const turnRanges: Array<[number, number]> = [];
    let turnStart = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'user') {
        if (turnStart >= 0) {
          turnRanges.push([turnStart, i - 1]);
        }
        turnStart = i;
      }
    }
    if (turnStart >= 0) {
      turnRanges.push([turnStart, messages.length - 1]);
    }

    for (const [start, end] of turnRanges) {
      // 步骤 1：单条卸载（> offloadThresholdBytes）
      for (let i = start; i <= end; i++) {
        const msg = messages[i]!;
        if (msg.role === 'tool') {
          const byteLen = Buffer.byteLength(msg.content, 'utf8');
          if (byteLen > offloadThresholdBytes) {
            await this._offloadSingle(msg as ProviderToolResultMessage, cacheDir);
          }
        }
      }

      // 步骤 2：轮级卸载（turn 内所有 tool 消息字节合计 > turnOffloadThresholdBytes）
      const toolMsgs = messages
        .slice(start, end + 1)
        .filter((m): m is ProviderToolResultMessage => m.role === 'tool')
        // 只统计尚未被卸载的（已卸载的 content 已变短）
        .map((m) => ({ msg: m, bytes: Buffer.byteLength(m.content, 'utf8') }));

      let totalBytes = toolMsgs.reduce((s, x) => s + x.bytes, 0);

      if (totalBytes > turnOffloadThresholdBytes) {
        // 按剩余字节从大到小排序，依次卸载直到合计 ≤ 阈值
        const sorted = [...toolMsgs].sort((a, b) => b.bytes - a.bytes);
        for (const { msg, bytes } of sorted) {
          if (totalBytes <= turnOffloadThresholdBytes) break;
          // 只卸载尚未被卸载的（已卸载的 content 以固定前缀开头）
          if (!msg.content.startsWith('[内容已卸载至文件:')) {
            await this._offloadSingle(msg, cacheDir);
            totalBytes -= bytes;
          }
        }
      }
    }
  }

  /**
   * 将单条 ProviderToolResultMessage 的 content 写入文件并替换为预览格式。
   * 写入失败时 console.warn 跳过，不抛异常。
   */
  private async _offloadSingle(msg: ProviderToolResultMessage, cacheDir: string): Promise<void> {
    const slug = msg.toolCallId.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 64);
    const fileName = `${slug}.txt`;
    const absolutePath = join(cacheDir, fileName);
    const originalContent = msg.content;
    const n = Buffer.byteLength(originalContent, 'utf8');
    const preview = originalContent.slice(0, 200);
    const writeFile = this.options._writeFile ?? fsWriteFile;

    try {
      await writeFile(absolutePath, originalContent, 'utf8');
      msg.content = `[内容已卸载至文件: ${absolutePath}，共 ${n} 字符]\n--- 内容预览（前 200 字符）---\n${preview}\n---\n如需完整内容，请用 read_file 重新读取原始路径。`;
    } catch (err) {
      console.warn(`[ContextManager] 卸载文件失败: ${absolutePath}`, err);
      // content 保持原值，不中断
    }
  }

  // ─────────────────────────────────────────────
  // F3-F6/F9：统一 compact、摘要降级与熔断
  // ─────────────────────────────────────────────

  async compact(messages: ChatMessage[], request: CompactionRequest): Promise<CompactionResult> {
    const selectedLevel = selectCompactionLevel({
      estimated: this.estimated,
      contextWindow: this.options.contextWindow,
      forceMargin: this.forceMargin,
      emergencyMargin: this.emergencyMargin,
    });

    if (request.trigger === 'auto' && selectedLevel === undefined) {
      return { outcome: 'skipped', reason: 'below_threshold', attempts: 0 };
    }

    const level: CompactionLevel = selectedLevel ?? 'normal';
    if (request.trigger === 'auto' && level === 'normal' && this.circuitOpen) {
      return { outcome: 'skipped', reason: 'circuit_open', level, attempts: 0 };
    }

    let turns: CompleteTurn[];
    try {
      turns = splitCompleteTurns(messages, this._compactedPrefixLength);
    } catch {
      return { outcome: 'failed', level, attempts: 0 };
    }

    const summaryTurnCount = countSummaryTurns(turns);
    if (summaryTurnCount === 0) {
      return { outcome: 'skipped', reason: 'no_history', attempts: 0 };
    }

    const summaryTurns = turns.slice(0, summaryTurnCount);
    const retainedTurns = turns.slice(summaryTurnCount);
    const recentFilePaths = this.selectRecentFilePaths();
    let skillRecoveryContents: string[];
    try {
      skillRecoveryContents = await this.getSkillRecoveryContents();
    } catch {
      return { outcome: 'failed', level, attempts: 0 };
    }

    const summaryResult = await this.callSummaryWithFallback(summaryTurns, request.originalUserMessages);

    if (summaryResult.kind === 'failure') {
      if (request.trigger === 'auto') {
        this._consecutiveSummaryFailures++;
      }
      return { outcome: 'failed', level, attempts: summaryResult.attempts };
    }

    const compactedPrefix = createSummaryMessages(summaryResult.summary);
    const fileRecoveryMessage = createFileRecoveryMessage(recentFilePaths);
    const skillRecoveryMessage = createSkillRecoveryMessage(skillRecoveryContents);
    if (fileRecoveryMessage !== undefined) {
      compactedPrefix.push(fileRecoveryMessage);
    }
    if (skillRecoveryMessage !== undefined) {
      compactedPrefix.push(skillRecoveryMessage);
    }
    const retainedMessages = retainedTurns.flatMap((turn) => turn.messages);
    const replacement = [...compactedPrefix, ...retainedMessages];

    messages.splice(0, messages.length, ...replacement);
    this._compactedPrefixLength = compactedPrefix.length;
    this.resetEstimate(messages);
    this._consecutiveSummaryFailures = 0;

    return { outcome: 'compacted', level, attempts: summaryResult.attempts };
  }

  private async callSummaryWithFallback(
    turns: readonly CompleteTurn[],
    originalUserMessages: readonly string[],
  ): Promise<SummaryFallbackResult> {
    let currentTurns = [...turns];
    let attempts = 0;
    const dropRatios = [undefined, 0.1, 0.1, 0.1, 0.2] as const;

    for (const dropRatio of dropRatios) {
      if (dropRatio !== undefined) {
        currentTurns = dropOldestTurns(currentTurns, dropRatio);
      }
      if (currentTurns.length === 0) {
        break;
      }

      attempts++;
      const attempt = await this.requestSummaryOnce(
        currentTurns.flatMap((turn) => turn.messages),
        originalUserMessages,
      );
      if (attempt.kind === 'success') {
        return { kind: 'success', summary: attempt.summary, attempts };
      }
      if (attempt.kind === 'failure') {
        break;
      }
    }

    return { kind: 'failure', attempts };
  }

  private async requestSummaryOnce(
    messages: readonly ChatMessage[],
    originalUserMessages: readonly string[],
  ): Promise<SummaryAttemptResult> {
    const request = {
      model: this.model,
      system: SUMMARY_SYSTEM_PROMPT,
      tools: [],
      toolChoice: 'none' as const,
      thinking: { enabled: false },
      messages: [...messages, { role: 'user' as const, content: SUMMARY_INSTRUCTION }],
      signal: AbortSignal.timeout(this.options.timeoutMs),
    };

    let fullText = '';
    let completed = false;
    try {
      for await (const event of this.provider.stream(request)) {
        if (event.type === 'content.delta') {
          fullText += event.delta;
        } else if (event.type === 'response.error') {
          return this.classifySummaryError(event.error);
        } else if (event.type === 'response.complete') {
          completed = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof AgentCodeError) {
        return this.classifySummaryError(error.publicError);
      }
      return error instanceof Error ? this.classifySummaryError(error.message) : { kind: 'failure' };
    }

    if (!completed) {
      return { kind: 'failure' };
    }

    const summary = finalizeSummary(fullText, originalUserMessages);
    return summary === undefined ? { kind: 'failure' } : { kind: 'success', summary };
  }

  private classifySummaryError(error: PublicError | string): SummaryAttemptResult {
    if (typeof error !== 'string' && error.code !== 'provider_error' && error.code !== 'unknown_error') {
      return { kind: 'failure' };
    }

    const message = typeof error === 'string' ? error : error.message;
    const normalizedMessage = message.replace(/[_-]+/g, ' ');
    const isRateOrQuotaLimit =
      /\brate\s+limit\b/i.test(normalizedMessage) ||
      /\btokens?\s+per\s+(?:second|minute|hour|day)\b/i.test(normalizedMessage);
    if (isRateOrQuotaLimit) {
      return { kind: 'failure' };
    }

    const hasExplicitInputLength =
      /\bcontext\s+(?:window|length)\b/i.test(normalizedMessage) ||
      /\bprompt\s+(?:is\s+)?too\s+long\b/i.test(normalizedMessage) ||
      /\binput\s+(?:is\s+)?too\s+long\b/i.test(normalizedMessage);
    if (hasExplicitInputLength) {
      return { kind: 'prompt_too_long' };
    }

    const isOutputLimit =
      /\b(?:output|completion)\b[^\r\n]{0,40}\btokens?\b/i.test(normalizedMessage) ||
      /\btokens?\b[^\r\n]{0,40}\b(?:output|completion)\b/i.test(normalizedMessage);
    if (isOutputLimit) {
      return { kind: 'failure' };
    }

    const isPromptTooLong =
      /\bmax(?:imum)?\b[^\r\n]{0,80}\btokens?\b/i.test(normalizedMessage) ||
      /\btokens?\s+limit\b/i.test(normalizedMessage);

    return isPromptTooLong ? { kind: 'prompt_too_long' } : { kind: 'failure' };
  }

  private recordFileAccesses(messages: readonly ChatMessage[]): void {
    const pendingCalls = new Map<string, FileAccessSource>();

    for (const message of messages) {
      if (message.role === 'assistant' && 'toolCalls' in message) {
        for (const call of message.toolCalls) {
          if (this.isFileAccessSource(call.name)) {
            pendingCalls.set(call.id, call.name);
          }
        }
        continue;
      }

      if (message.role !== 'tool') {
        continue;
      }

      const source = pendingCalls.get(message.toolCallId);
      if (source === undefined) {
        continue;
      }
      pendingCalls.delete(message.toolCallId);
      if (message.isError !== false || message.toolName !== source) {
        continue;
      }

      for (const path of this.extractStructuredPaths(source, message.content)) {
        this.recordFileAccess(source, path);
      }
    }
  }

  private isFileAccessSource(name: string): name is FileAccessSource {
    return FILE_ACCESS_SOURCES.some((source) => source === name);
  }

  private extractStructuredPaths(source: FileAccessSource, content: string): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return [];
    }

    if (source === 'read_file') {
      const path = (parsed as { path?: unknown }).path;
      return typeof path === 'string' ? [path] : [];
    }

    const matches = (parsed as { matches?: unknown }).matches;
    if (!Array.isArray(matches)) {
      return [];
    }
    if (source === 'glob_files') {
      return matches.filter((path): path is string => typeof path === 'string');
    }
    return matches.flatMap((match) => {
      if (typeof match !== 'object' || match === null) {
        return [];
      }
      const path = (match as { path?: unknown }).path;
      return typeof path === 'string' ? [path] : [];
    });
  }

  private recordFileAccess(source: FileAccessSource, rawPath: string): void {
    const path = this.normalizeFilePath(rawPath);
    if (path === undefined) {
      return;
    }

    const existingIndex = this.recentFileAccesses.findIndex(
      (record) => record.source === source && record.path === path,
    );
    if (existingIndex >= 0) {
      this.recentFileAccesses.splice(existingIndex, 1);
    }
    this.recentFileAccesses.push({ path, source, sequence: ++this._fileAccessSequence });

    const sourceRecords = this.recentFileAccesses
      .filter((record) => record.source === source)
      .sort((left, right) => left.sequence - right.sequence);
    while (sourceRecords.length > MAX_RECENT_FILES_PER_SOURCE) {
      const oldest = sourceRecords.shift();
      if (oldest === undefined) {
        break;
      }
      const oldestIndex = this.recentFileAccesses.indexOf(oldest);
      if (oldestIndex >= 0) {
        this.recentFileAccesses.splice(oldestIndex, 1);
      }
    }
  }

  private normalizeFilePath(path: string): string | undefined {
    if (path.length === 0) {
      return undefined;
    }
    return posix.normalize(path.replaceAll('\\', '/'));
  }

  private selectRecentFilePaths(): string[] {
    const selected: string[] = [];
    const seen = new Set<string>();

    for (const source of FILE_ACCESS_SOURCES) {
      const sourceRecords = this.recentFileAccesses
        .filter((record) => record.source === source)
        .sort((left, right) => right.sequence - left.sequence);
      for (const record of sourceRecords) {
        if (seen.has(record.path)) {
          continue;
        }
        seen.add(record.path);
        selected.push(record.path);
        if (selected.length === MAX_FILE_RECOVERY_PATHS) {
          return selected;
        }
      }
    }

    return selected;
  }

  private async getSkillRecoveryContents(): Promise<string[]> {
    const snapshots = await this.skillContextSource.getUsedSkillDefinitions();
    if (!Array.isArray(snapshots) || !snapshots.every(this.isSkillDefinitionSnapshot)) {
      throw new TypeError('Skill context source 返回了无效快照');
    }

    const selected: string[] = [];
    let remainingChars = SKILL_RECOVERY_CHAR_BUDGET;
    const sorted = [...snapshots].sort((left, right) => right.lastUsedOrder - left.lastUsedOrder);
    for (const snapshot of sorted) {
      if (snapshot.renderedContent.length === 0) {
        continue;
      }
      if (snapshot.renderedContent.length <= remainingChars) {
        selected.push(snapshot.renderedContent);
        remainingChars -= snapshot.renderedContent.length;
        continue;
      }
      if (remainingChars > 0) {
        selected.push(snapshot.renderedContent.slice(0, remainingChars));
      }
      break;
    }
    return selected;
  }

  private isSkillDefinitionSnapshot(value: unknown): value is SkillDefinitionSnapshot {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const snapshot = value as Partial<SkillDefinitionSnapshot>;
    return (
      typeof snapshot.id === 'string' &&
      typeof snapshot.renderedContent === 'string' &&
      typeof snapshot.lastUsedOrder === 'number' &&
      Number.isFinite(snapshot.lastUsedOrder)
    );
  }

  private resetEstimate(messages: readonly ChatMessage[]): void {
    this._lastKnownTotalPromptTokens = 0;
    this._pendingChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  }
}
