import type { ChatMessage } from '../providers/types.js';

export const NORMAL_MARGIN = 13_000;
export const USER_MESSAGES_PLACEHOLDER = '{{ALL_USER_MESSAGES_VERBATIM}}';

const FORCE_RATIO = 0.75;
const EMERGENCY_RATIO = 0.9;
const RETAIN_TOKEN_TARGET = 10_000;
const RETAIN_TURN_TARGET = 5;

const SUMMARY_HEADINGS = [
  '主要请求和意图',
  '关键技术概念',
  '文件和代码段',
  '错误和修复',
  '问题解决过程',
  '所有用户消息',
  '待办任务',
  '当前工作',
  '可能的下一步',
] as const;

export type CompactionTrigger = 'auto' | 'manual';
export type CompactionLevel = 'normal' | 'force' | 'emergency';

export interface CompactionRequest {
  trigger: CompactionTrigger;
  messages: readonly ChatMessage[];
  estimatedTokens: number;
  contextWindow: number;
  prefixLength?: number;
  level?: CompactionLevel;
}

interface CompactionResultBase {
  messages?: ChatMessage[];
  level?: CompactionLevel;
  reason?: string;
  error?: unknown;
}

export type CompactionResult =
  | (CompactionResultBase & { outcome: 'compacted' })
  | (CompactionResultBase & { outcome: 'emergency_fallback' })
  | (CompactionResultBase & { outcome: 'skipped' })
  | (CompactionResultBase & { outcome: 'failed' });

export interface CompleteTurn {
  messages: ChatMessage[];
  estimatedTokens: number;
}

export type SkillContextSource = string;

export interface SkillDefinitionSnapshot {
  name: string;
  content: string;
  source?: SkillContextSource;
}

type UserMessageInput = string | ChatMessage;

/** Selects the most urgent level whose watermark has been crossed. */
export function selectCompactionLevel(estimatedTokens: number, contextWindow: number): CompactionLevel | undefined {
  if (estimatedTokens > contextWindow * EMERGENCY_RATIO) {
    return 'emergency';
  }
  if (estimatedTokens > contextWindow * FORCE_RATIO) {
    return 'force';
  }
  if (estimatedTokens > contextWindow - NORMAL_MARGIN) {
    return 'normal';
  }
  return undefined;
}

/**
 * Splits the non-prefix portion into user turns and validates tool-call integrity.
 */
export function splitCompleteTurns(messages: readonly ChatMessage[], prefixLength: number): CompleteTurn[] {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > messages.length) {
    throw new RangeError('prefixLength 必须是消息范围内的整数');
  }

  if (prefixLength === messages.length) {
    return [];
  }
  if (messages[prefixLength]?.role !== 'user') {
    throw new Error('压缩前缀必须结束在完整 turn 的边界上');
  }

  const turns: CompleteTurn[] = [];
  let start = prefixLength;
  for (let index = prefixLength + 1; index <= messages.length; index++) {
    if (index === messages.length || messages[index]?.role === 'user') {
      const turnMessages = messages.slice(start, index);
      validateToolPairs(turnMessages);
      const characterCount = turnMessages.reduce((total, current) => total + current.content.length, 0);
      turns.push({
        messages: turnMessages,
        estimatedTokens: Math.ceil(characterCount / 4),
      });
      start = index;
    }
  }

  return turns;
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

    if (current.role === 'tool') {
      if (!outstanding.delete(current.toolCallId)) {
        throw new Error(`孤立的工具结果: ${current.toolCallId}`);
      }
    }
  }

  if (outstanding.size > 0) {
    throw new Error(`工具调用缺少结果: ${[...outstanding].join(', ')}`);
  }
}

/** Returns how many oldest turns are outside the retained tail window. */
export function countSummaryTurns(turns: readonly CompleteTurn[]): number {
  let retainedTokens = 0;
  let retainedTurns = 0;

  for (let index = turns.length - 1; index >= 0; index--) {
    retainedTokens += turns[index]!.estimatedTokens;
    retainedTurns++;
    if (retainedTokens >= RETAIN_TOKEN_TARGET || retainedTurns >= RETAIN_TURN_TARGET) {
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
export function renderVerbatimUserMessages(messages: readonly UserMessageInput[]): string {
  const contents = messages.flatMap((current) => {
    if (typeof current === 'string') {
      return [current];
    }
    return current.role === 'user' ? [current.content] : [];
  });

  return contents
    .map((content, index) => `<user_message index="${index + 1}" length="${content.length}">${content}</user_message>`)
    .join('\n');
}

/** Validates the model response and injects the original user messages. */
export function finalizeSummary(response: string, userMessages: readonly UserMessageInput[]): string | undefined {
  if (typeof response !== 'string') {
    return undefined;
  }

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
  if (/\bundefined\b/.test(body)) {
    return undefined;
  }

  const headingMatches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  const headings = headingMatches.map((heading) => heading[1]);
  if (
    headings.length !== SUMMARY_HEADINGS.length ||
    headings.some((heading, index) => heading !== SUMMARY_HEADINGS[index])
  ) {
    return undefined;
  }

  const placeholderMatches = response.match(/\{\{ALL_USER_MESSAGES_VERBATIM\}\}/g) ?? [];
  if (placeholderMatches.length !== 1) {
    return undefined;
  }

  const userHeading = headingMatches[5]!;
  const nextHeading = headingMatches[6]!;
  const userSectionStart = userHeading.index! + userHeading[0].length;
  const userSectionEnd = nextHeading.index!;
  const placeholder = body.indexOf(USER_MESSAGES_PLACEHOLDER);
  if (placeholder < userSectionStart || placeholder >= userSectionEnd) {
    return undefined;
  }

  return body.replace(USER_MESSAGES_PLACEHOLDER, renderVerbatimUserMessages(userMessages)).trim();
}

export function createSummaryMessages(summary: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content: `[会话历史摘要]\n${summary}`,
    },
    {
      role: 'assistant',
      content: '[上下文压缩边界] 较早的会话历史已由摘要替代。需要文件或代码细节时请重新读取，不要根据摘要猜测。',
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

export function createSkillRecoveryMessage(definitions: readonly SkillDefinitionSnapshot[]): ChatMessage | undefined {
  if (definitions.length === 0) {
    return undefined;
  }

  return {
    role: 'user',
    content: `[技能定义恢复]\n${definitions.map((definition) => definition.content).join('\n\n')}`,
  };
}

export function createEmergencyMessages(userMessages: readonly UserMessageInput[]): ChatMessage[] {
  return [
    {
      role: 'user',
      content: `[紧急恢复的用户原文]\n${renderVerbatimUserMessages(userMessages)}`,
    },
    {
      role: 'assistant',
      content: '[紧急压缩边界] 摘要失败，较早的 assistant/tool 消息已丢失；以上仅保留全部用户原文。',
    },
  ];
}
