import { describe, expect, it } from 'vitest';

import {
  NORMAL_MARGIN,
  USER_MESSAGES_PLACEHOLDER,
  countSummaryTurns,
  createEmergencyMessages,
  createFileRecoveryMessage,
  createSkillRecoveryMessage,
  createSummaryMessages,
  dropOldestTurns,
  finalizeSummary,
  renderVerbatimUserMessages,
  selectCompactionLevel,
  splitCompleteTurns,
} from '../../../src/context/compaction.js';

type Message = Parameters<typeof splitCompleteTurns>[0][number];

const message = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message =>
  ({ role, content, ...extra }) as Message;

const validDraft = [
  '<summary>\n## 主要请求和意图\n请求',
  '## 关键技术概念\n概念',
  '## 文件和代码段\n文件',
  '## 错误和修复\n错误',
  '## 问题解决过程\n过程',
  `## 所有用户消息\n${USER_MESSAGES_PLACEHOLDER}`,
  '## 待办任务\n待办',
  '## 当前工作\n工作',
  '## 可能的下一步\n下一步\n</summary>',
].join('\n\n');

describe('compaction primitives', () => {
  it('uses the public constants and strict compaction thresholds', () => {
    expect(NORMAL_MARGIN).toBe(13_000);
    expect(USER_MESSAGES_PLACEHOLDER).toBe('{{ALL_USER_MESSAGES_VERBATIM}}');

    expect(selectCompactionLevel(7_000, 20_000)).toBeUndefined();
    expect(selectCompactionLevel(7_001, 20_000)).toBe('normal');
    expect(selectCompactionLevel(15_000, 20_000)).toBe('normal');
    expect(selectCompactionLevel(15_001, 20_000)).toBe('force');
    expect(selectCompactionLevel(18_000, 20_000)).toBe('force');
    expect(selectCompactionLevel(18_001, 20_000)).toBe('emergency');
  });

  it('splits complete user turns after a retained prefix and pairs multiple tools', () => {
    const messages: Message[] = [
      message('assistant', 'prefix'),
      message('user', 'one'),
      message('assistant', 'working', {
        toolCalls: [
          { id: 'call-a', name: 'a', argumentsText: '{}' },
          { id: 'call-b', name: 'b', argumentsText: '{}' },
        ],
      } as Partial<Message>),
      message('tool', 'A', { toolCallId: 'call-a', toolName: 'a', isError: false } as Partial<Message>),
      message('tool', 'B', { toolCallId: 'call-b', toolName: 'b', isError: false } as Partial<Message>),
      message('assistant', 'done'),
      message('user', 'two'),
      message('assistant', 'ok'),
    ];

    const turns = splitCompleteTurns(messages, 1);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.messages).toEqual(messages.slice(1, 6));
    expect(turns[0]!.estimatedTokens).toBe(Math.ceil('oneworkingABdone'.length / 4));
    expect(turns[1]!.messages).toEqual(messages.slice(6));
  });

  it('rejects an invalid prefix and incomplete or orphaned tool traffic', () => {
    expect(() => splitCompleteTurns([message('user', 'x')], -1)).toThrow();
    expect(() => splitCompleteTurns([message('user', 'x')], 2)).toThrow();
    expect(() =>
      splitCompleteTurns(
        [
          message('user', 'x'),
          message('tool', 'orphan', {
            toolCallId: 'missing',
            toolName: 'x',
            isError: false,
          } as Partial<Message>),
        ],
        0,
      ),
    ).toThrow();
    expect(() =>
      splitCompleteTurns(
        [
          message('user', 'x'),
          message('assistant', '', {
            toolCalls: [{ id: 'missing', name: 'x', argumentsText: '{}' }],
          } as Partial<Message>),
        ],
        0,
      ),
    ).toThrow();
  });

  it('counts the newest complete turns until either retention limit is reached', () => {
    const turns = [2_000, 2_000, 2_000, 2_000, 2_000, 2_000].map((estimatedTokens, index) => ({
      messages: [message('user', String(index))],
      estimatedTokens,
    }));
    expect(countSummaryTurns(turns)).toBe(1);

    const tokenBounded = [6_000, 11_000, 1_000].map((estimatedTokens, index) => ({
      messages: [message('user', String(index))],
      estimatedTokens,
    }));
    expect(countSummaryTurns(tokenBounded)).toBe(1);
  });

  it('drops the oldest turns without mutating the input', () => {
    const turns = [1, 2, 3, 4].map((value) => ({
      messages: [message('user', String(value))],
      estimatedTokens: value,
    }));
    const snapshot = [...turns];
    expect(dropOldestTurns(turns, 0.26)).toEqual(turns.slice(2));
    expect(dropOldestTurns(turns, 0)).toEqual(turns.slice(1));
    expect(turns).toEqual(snapshot);
  });

  it('renders every user message exactly, including whitespace and markup', () => {
    const users = ['  keep <xml> & text  ', '', '重复', '重复'];
    const rendered = renderVerbatimUserMessages(users);
    expect(rendered).toBe(
      users
        .map((body, index) => `<user_message index="${index + 1}" length="${body.length}">${body}</user_message>`)
        .join('\n'),
    );
  });

  it('finalizes exactly one ordered nine-section summary and replaces the sole placeholder', () => {
    const userText = ['first', '  <second>  '];
    const result = finalizeSummary(validDraft, userText);
    const headings = [...result.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      '主要请求和意图',
      '关键技术概念',
      '文件和代码段',
      '错误和修复',
      '问题解决过程',
      '所有用户消息',
      '待办任务',
      '当前工作',
      '可能的下一步',
    ]);
    expect(result).not.toContain(USER_MESSAGES_PLACEHOLDER);
    expect(result).toContain('<user_message index="2" length="12">  <second>  </user_message>');
    expect(result).not.toMatch(/<analysis>/i);
    expect(result).not.toContain('undefined');
  });

  it('rejects malformed drafts, duplicate sections/placeholders, analysis and undefined', () => {
    expect(() => finalizeSummary(validDraft.replace('## 当前工作', '## 待办任务'), ['x'])).toThrow();
    expect(() => finalizeSummary(validDraft.replace(USER_MESSAGES_PLACEHOLDER, 'missing'), ['x'])).toThrow();
    expect(() => finalizeSummary(`${validDraft}\n${USER_MESSAGES_PLACEHOLDER}`, ['x'])).toThrow();
    expect(() => finalizeSummary(validDraft.replace('请求', '<analysis>secret</analysis>'), ['x'])).toThrow();
    expect(() => finalizeSummary(validDraft.replace('请求', 'undefined'), ['x'])).toThrow();
  });

  it('creates summary, file, skill, and emergency recovery messages', () => {
    const summary = createSummaryMessages('final summary');
    expect(summary).toHaveLength(2);
    expect(summary[0]!.role).toBe('user');
    expect(summary[0]!.content).toContain('final summary');
    expect(summary[1]!.role).toBe('assistant');
    expect(summary[1]!.content).toMatch(/压缩|摘要|边界/);

    expect(createFileRecoveryMessage([])).toBeUndefined();
    const files = createFileRecoveryMessage(['src/a.ts', 'docs/b.md']);
    expect(files?.role).toBe('user');
    expect(files?.content).toContain('src/a.ts');
    expect(files?.content).toContain('docs/b.md');
    expect(files?.content).toMatch(/重新读取|重读/);

    expect(createSkillRecoveryMessage([])).toBeUndefined();
    const skills = createSkillRecoveryMessage([
      { name: 'first', content: 'FIRST BODY' },
      { name: 'second', content: 'SECOND BODY' },
    ]);
    expect(skills?.role).toBe('user');
    expect(skills?.content.indexOf('FIRST BODY')).toBeLessThan(skills?.content.indexOf('SECOND BODY') ?? -1);

    const emergency = createEmergencyMessages([' a ', '<b>']);
    expect(emergency).toHaveLength(2);
    expect(emergency[0]!.role).toBe('user');
    expect(emergency[0]!.content).toContain('<user_message index="1" length="3"> a </user_message>');
    expect(emergency[1]!.role).toBe('assistant');
    expect(emergency[1]!.content).toMatch(/摘要失败/);
    expect(emergency[1]!.content).toMatch(/assistant.*tool|工具.*助理/i);
  });
});
