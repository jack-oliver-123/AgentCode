import type { ChatMessage } from '../providers/types.js';

export const NORMAL_MARGIN = 13_000;
export const USER_MESSAGES_PLACEHOLDER = '{{ALL_USER_MESSAGES_VERBATIM}}';

const RETAIN_TOKEN_TARGET = 10_000;
const RETAIN_TURN_TARGET = 5;

const SUMMARY_HEADINGS = [
  '## 1. 主要请求和意图',
  '## 2. 关键技术概念',
  '## 3. 文件和代码段',
  '## 4. 错误和修复',
  '## 5. 问题解决过程',
  '## 6. 所有用户消息',
  '## 7. 待办任务',
  '## 8. 当前工作',
  '## 9. 可能的下一步',
] as const;

export type CompactionTrigger = 'auto' | 'manual';
export type CompactionLevel = 'normal' | 'force' | 'emergency';

export interface CompactionRequest {
  trigger: CompactionTrigger;
  originalUserMessages: readonly string[];
  /** 仅本次手动压缩使用的附加保留要求。 */
  instructions?: string;
}

export type CompactionResult =
  | { outcome: 'compacted'; level: CompactionLevel; attempts: number }
  | { outcome: 'emergency_fallback'; level: 'emergency'; attempts: number }
  | {
      outcome: 'skipped';
      reason: 'below_threshold' | 'circuit_open' | 'no_history';
      level?: CompactionLevel;
      attempts: 0;
    }
  | { outcome: 'failed'; level: CompactionLevel; attempts: number };

export interface CompleteTurn {
  start: number;
  endExclusive: number;
  messages: readonly ChatMessage[];
  estimatedTokens: number;
}

export interface SkillDefinitionSnapshot {
  id: string;
  renderedContent: string;
  lastUsedOrder: number;
}

export interface SkillContextSource {
  getUsedSkillDefinitions(): Promise<readonly SkillDefinitionSnapshot[]>;
}

/** Selects the most urgent level whose fixed-margin watermark has been crossed. */
export function selectCompactionLevel(input: {
  estimated: number;
  contextWindow: number;
  forceMargin: number;
  emergencyMargin: number;
}): CompactionLevel | undefined {
  if (input.estimated > input.contextWindow - input.emergencyMargin) {
    return 'emergency';
  }
  if (input.estimated > input.contextWindow - input.forceMargin) {
    return 'force';
  }
  if (input.estimated > input.contextWindow - NORMAL_MARGIN) {
    return 'normal';
  }
  return undefined;
}

/** Splits the non-prefix portion into user turns and validates tool-call integrity. */
export function splitCompleteTurns(messages: readonly ChatMessage[], prefixLength: number): CompleteTurn[] {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > messages.length) {
    throw new RangeError('prefixLength 必须是消息范围内的整数');
  }

  if (prefixLength === messages.length) {
    return [];
  }
  if (!isTurnBoundary(messages[prefixLength])) {
    throw new Error('压缩前缀必须结束在完整 turn 的边界上');
  }

  const turns: CompleteTurn[] = [];
  let start = prefixLength;
  for (let index = prefixLength + 1; index <= messages.length; index++) {
    if (index === messages.length || isTurnBoundary(messages[index])) {
      const turnMessages = messages.slice(start, index);
      validateToolPairs(turnMessages);
      const characterCount = turnMessages.reduce((total, current) => total + current.content.length, 0);
      turns.push({
        start,
        endExclusive: index,
        messages: turnMessages,
        estimatedTokens: Math.ceil(characterCount / 4),
      });
      start = index;
    }
  }

  return turns;
}

function isTurnBoundary(message: ChatMessage | undefined): boolean {
  return message?.role === 'user' && message.provenance !== 'steer';
}

function validateToolPairs(messages: readonly ChatMessage[]): void {
  const outstanding = new Set<string>();

  for (const current of messages) {
    if (current.role === 'assistant' && 'toolCalls' in current) {
      for (const call of current.toolCalls) {
        if (outstanding.has(call.id)) {
          throw new Error(`重复的工具调用 ID: ${call.id}`);
        }
        outstanding.add(call.id);
      }
      continue;
    }

    if (current.role === 'tool' && !outstanding.delete(current.toolCallId)) {
      throw new Error(`孤立的工具结果: ${current.toolCallId}`);
    }
  }

  if (outstanding.size > 0) {
    throw new Error(`工具调用缺少结果: ${[...outstanding].join(', ')}`);
  }
}

/** Returns how many oldest turns are outside the retained tail window. */
export function countSummaryTurns(
  turns: readonly CompleteTurn[],
  retainTokens = RETAIN_TOKEN_TARGET,
  retainTurns = RETAIN_TURN_TARGET,
): number {
  let retainedTokens = 0;
  let retainedTurns = 0;

  for (let index = turns.length - 1; index >= 0; index--) {
    retainedTokens += turns[index]!.estimatedTokens;
    retainedTurns++;
    if (retainedTokens >= retainTokens || retainedTurns >= retainTurns) {
      break;
    }
  }

  return Math.max(0, turns.length - retainedTurns);
}

/** Drops an oldest fraction while leaving the input array untouched. */
export function dropOldestTurns(turns: readonly CompleteTurn[], ratio: number): CompleteTurn[] {
  if (turns.length === 0) {
    return [];
  }
  if (Number.isNaN(ratio)) {
    throw new TypeError('ratio 不能是 NaN');
  }

  const dropCount = Math.max(1, Math.ceil(turns.length * ratio));
  return turns.slice(dropCount);
}

/** Serializes user content without normalizing or escaping it. */
export function renderVerbatimUserMessages(messages: readonly string[]): string {
  return messages
    .map(
      (content, index) =>
        `<user_message index="${index + 1}" length="${content.length}">\n${content}\n</user_message>`,
    )
    .join('\n');
}

interface SummaryHeading {
  text: string;
  index: number;
  length: number;
}

interface CodeFence {
  marker: '`' | '~';
  length: number;
}

function findStructuralHeadings(body: string): SummaryHeading[] {
  const headings: SummaryHeading[] = [];
  let fence: CodeFence | undefined;
  let lineStart = 0;

  while (lineStart <= body.length) {
    const newlineIndex = body.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? body.length : newlineIndex;
    const contentEnd = lineEnd > lineStart && body[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = body.slice(lineStart, contentEnd);
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

    if (fence) {
      const run = fenceMatch?.[1];
      const trailing = fenceMatch?.[2];
      if (
        run !== undefined &&
        trailing !== undefined &&
        run[0] === fence.marker &&
        run.length >= fence.length &&
        /^[ \t]*$/.test(trailing)
      ) {
        fence = undefined;
      }
    } else if (fenceMatch) {
      const run = fenceMatch[1]!;
      const trailing = fenceMatch[2]!;
      const marker = run[0] as '`' | '~';
      if (marker === '~' || !trailing.includes('`')) {
        fence = { marker, length: run.length };
      }
    } else if (/^##(?:[ \t]+|$)/.test(line)) {
      headings.push({ text: line, index: lineStart, length: line.length });
    }

    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }

  return headings;
}

/** Validates the model response and injects the original user messages. */
export function finalizeSummary(response: string, userMessages: readonly string[]): string | undefined {
  const openingTags = response.match(/<summary>/g) ?? [];
  const closingTags = response.match(/<\/summary>/g) ?? [];
  const match = response.match(/<summary>([\s\S]*?)<\/summary>/);
  if (openingTags.length !== 1 || closingTags.length !== 1 || !match) {
    return undefined;
  }

  const body = match[1]!;
  if (/<\/?analysis\b/i.test(body)) {
    return undefined;
  }

  const headingMatches = findStructuralHeadings(body);
  if (
    headingMatches.length !== SUMMARY_HEADINGS.length ||
    headingMatches.some((heading, index) => heading.text !== SUMMARY_HEADINGS[index])
  ) {
    return undefined;
  }

  const placeholderMatches = response.match(/\{\{ALL_USER_MESSAGES_VERBATIM\}\}/g) ?? [];
  if (placeholderMatches.length !== 1) {
    return undefined;
  }

  const userHeading = headingMatches[5]!;
  const nextHeading = headingMatches[6]!;
  const userSectionStart = userHeading.index + userHeading.length;
  const userSectionEnd = nextHeading.index;
  if (body.slice(userSectionStart, userSectionEnd).trim() !== USER_MESSAGES_PLACEHOLDER) {
    return undefined;
  }

  return body
    .replace(USER_MESSAGES_PLACEHOLDER, () => renderVerbatimUserMessages(userMessages))
    .trim();
}

export function createSummaryMessages(summary: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content: `[会话历史摘要]\n${summary}`,
    },
    {
      role: 'assistant',
      content: '[上下文已压缩] 较早的会话历史已由摘要替代。需要文件或代码细节时请重新读取，不要根据摘要猜测。',
    },
  ];
}

export function createFileRecoveryMessage(paths: readonly string[]): ChatMessage | undefined {
  if (paths.length === 0) {
    return undefined;
  }

  return {
    role: 'user',
    content: `[文件恢复提示] 请重新读取以下文件，不要依赖摘要推断文件内容：\n${paths.join('\n')}`,
  };
}

export function createSkillRecoveryMessage(contents: readonly string[]): ChatMessage | undefined {
  if (contents.length === 0) {
    return undefined;
  }

  return {
    role: 'user',
    content: `[技能定义恢复]\n${contents.join('\n\n')}`,
  };
}

export function createEmergencyMessages(userMessages: readonly string[]): ChatMessage[] {
  return [
    {
      role: 'user',
      content: `[紧急上下文恢复]\n${renderVerbatimUserMessages(userMessages)}`,
    },
    {
      role: 'assistant',
      content: '[上下文已紧急压缩] 未生成摘要，较早的 assistant/tool 信息已丢失；以上仅保留全部用户原文。',
    },
  ];
}
