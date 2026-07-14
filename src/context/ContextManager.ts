import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

import type { ChatModelProvider, ChatMessage, ProviderToolResultMessage } from '../providers/types.js';

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

  /** F1：上次已知的累计 prompt token 数 */
  private _lastKnownTotalPromptTokens = 0;
  /** F1：自上次 token 汇报后追加的字符数 */
  private _pendingChars = 0;

  /** F5：连续摘要失败次数 */
  private _consecutiveSummaryFailures = 0;

  constructor(
    provider: ChatModelProvider,
    model: string,
    options: ContextManagerOptions,
  ) {
    this.provider = provider;
    this.model = model;
    this.options = options;
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

  /**
   * 向 providerContext 追加消息后调用，传入追加的内容字符数之和。
   */
  onMessagesAppended(chars: number): void {
    this._pendingChars += chars;
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
        .map(m => ({ msg: m, bytes: Buffer.byteLength(m.content, 'utf8') }));

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
  private async _offloadSingle(
    msg: ProviderToolResultMessage,
    cacheDir: string,
  ): Promise<void> {
    const slug = msg.toolCallId.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 64);
    const fileName = `${slug}.txt`;
    const absolutePath = join(cacheDir, fileName);
    const originalContent = msg.content;
    const n = Buffer.byteLength(originalContent, 'utf8');
    const preview = originalContent.slice(0, 200);
    const writeFile = this.options._writeFile ?? fsWriteFile;

    try {
      await writeFile(absolutePath, originalContent, 'utf8');
      msg.content =
        `[内容已卸载至文件: ${absolutePath}，共 ${n} 字符]\n` +
        `--- 内容预览（前 200 字符）---\n` +
        `${preview}\n` +
        `---\n` +
        `如需完整内容，请用 read_file 重新读取原始路径。`;
    } catch (err) {
      console.warn(`[ContextManager] 卸载文件失败: ${absolutePath}`, err);
      // content 保持原值，不中断
    }
  }

  // ─────────────────────────────────────────────
  // F3/F4/F5：LLM 摘要压缩（T4 实现）
  // ─────────────────────────────────────────────

  /**
   * 执行 LLM 摘要压缩。
   * - manual=false（默认）：自动路径，safetyMargin=13000；熔断时跳过返回 true
   * - manual=true：手动路径，safetyMargin=3000（由 Controller 层预先做水位检查）
   * 返回 true 表示压缩成功或跳过（非失败），false 表示摘要失败。
   */
  async compress(
    messages: ChatMessage[],
    protectedIndices: Set<number>,
    manual = false,
  ): Promise<boolean> {
    const safetyMargin = manual ? 3000 : 13000;
    const threshold = this.options.contextWindow - safetyMargin;

    // 自动路径水位检查
    if (!manual && this.estimated <= threshold) {
      return true; // 未到阈值，跳过（非失败）
    }

    // F5：熔断检查（仅阻止自动触发）
    if (!manual && this.circuitOpen) {
      return true;
    }

    // 计算保留窗口（N 值）
    let N = this._calcRetainFrom(messages);

    // 受保护消息截断：若 protectedIndices 含小于 N 的下标，将 N 截断到最小受保护下标
    for (const idx of protectedIndices) {
      if (idx < N) {
        N = idx;
      }
    }

    // 待摘要区 < 2 条，跳过（非失败）
    if (N < 2) {
      return true;
    }

    // 发起 LLM 摘要调用
    const summaryArea = messages.slice(0, N);
    let summaryText: string | null = null;
    try {
      summaryText = await this._callSummaryLLM(summaryArea);
    } catch {
      // 异常视为失败
    }

    if (!summaryText) {
      if (!manual) this._consecutiveSummaryFailures++;
      return false;
    }

    // 应用摘要：替换 messages 头部
    const userSummaryMsg: ChatMessage = {
      role: 'user',
      content: `[会话历史摘要]\n${summaryText}`,
    };
    const boundaryMsg: ChatMessage = {
      role: 'assistant',
      content:
        '[上下文已压缩] 较早的会话历史已被摘要替代。\n' +
        '如需文件具体内容或代码细节，请使用 read_file / search_code 重新读取，\n' +
        '不要根据摘要推断代码内容。',
    };

    messages.splice(0, N, userSummaryMsg, boundaryMsg);

    // 重置估算（全量重扫）
    this._lastKnownTotalPromptTokens = 0;
    this._pendingChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0) * 4;
    // pendingChars 存字符数，estimated = ceil(pendingChars/4) = totalChars
    // 实际：pendingChars = totalChars，estimated = ceil(totalChars/4)
    const totalChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
    this._lastKnownTotalPromptTokens = 0;
    this._pendingChars = totalChars * 4; // estimated = ceil(totalChars*4/4) = totalChars

    // 等等，spec 说"pendingChars = 全部消息 content 字段字符数之和"
    // estimated = lastKnown + ceil(pendingChars/4) = 0 + ceil(totalChars/4)
    // 所以 pendingChars 应该 = totalChars（字符数），而不是 *4
    this._pendingChars = totalChars;

    // 下标重映射
    const newIndices = new Set<number>();
    for (const i of protectedIndices) {
      if (i >= N) {
        newIndices.add(i - N + 2);
      }
      // i < N 的被移除（随摘要区删除）
    }
    protectedIndices.clear();
    for (const i of newIndices) protectedIndices.add(i);

    // 成功：重置熔断计数
    this._consecutiveSummaryFailures = 0;
    return true;
  }

  /**
   * 从尾部往前计算保留窗口，返回 retainFrom 下标（N）。
   * 待摘要区 = messages[0..N-1]，保留区 = messages[N..]
   */
  private _calcRetainFrom(messages: ChatMessage[]): number {
    let accChars = 0;
    let turnCount = 0;
    let retainFrom = messages.length; // 默认全部保留

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      accChars += msg.content?.length ?? 0;
      if (msg.role === 'user') {
        turnCount++;
      }
      const accTokens = Math.ceil(accChars / 4);
      if (accTokens >= 10000 || turnCount >= 5) {
        retainFrom = i;
        break;
      }
    }

    return retainFrom;
  }

  /**
   * 向 LLM 发起摘要请求，返回提取的摘要文本，失败返回 null。
   */
  private async _callSummaryLLM(summaryArea: ChatMessage[]): Promise<string | null> {
    const SUMMARY_SYSTEM_PROMPT =
      '你是精确的会话历史摘要器。严格遵守以下规则：\n' +
      '1. 禁止调用任何工具。\n' +
      '2. 先在 <analysis> 标签内写出思考草稿（只用于推理，不出现在最终摘要中）。\n' +
      '3. 在 <summary> 标签内按四个固定章节输出正式摘要。\n' +
      '4. 不捏造未明确出现在历史中的文件内容或代码。';

    const SUMMARY_INSTRUCTION =
      '以上是对话历史片段，请按如下格式生成摘要：\n' +
      '<summary>\n' +
      '## 目标与背景\n' +
      '## 已完成操作\n' +
      '## 关键发现（含重要文件路径、结论）\n' +
      '## 未完成/待续\n' +
      '</summary>';

    const request = {
      model: this.model,
      system: SUMMARY_SYSTEM_PROMPT,
      tools: [] as any[],
      toolChoice: 'none' as const,
      thinking: { enabled: false },
      messages: [
        ...summaryArea,
        { role: 'user' as const, content: SUMMARY_INSTRUCTION },
      ],
      ...(this.options.timeoutMs > 0
        ? { signal: AbortSignal.timeout(this.options.timeoutMs) }
        : {}),
    };

    let fullText = '';
    try {
      for await (const event of this.provider.stream(request as any)) {
        if (event.type === 'content.delta') {
          fullText += event.delta;
        } else if (event.type === 'response.error') {
          return null;
        } else if (event.type === 'response.complete') {
          break;
        }
      }
    } catch {
      return null;
    }

    const match = fullText.match(/<summary>([\s\S]*?)<\/summary>/);
    return match ? match[1]!.trim() : null;
  }
}
