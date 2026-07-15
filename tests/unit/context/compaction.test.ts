import { describe, expect, expectTypeOf, it } from 'vitest';

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
  type CompactionLevel,
  type CompactionRequest,
  type CompactionResult,
  type CompleteTurn,
  type SkillContextSource,
  type SkillDefinitionSnapshot,
} from '../../../src/context/compaction.js';

type Message = Parameters<typeof splitCompleteTurns>[0][number];

const message = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message =>
  ({ role, content, ...extra }) as Message;

const completeTurn = (estimatedTokens: number, index: number): CompleteTurn => ({
  start: index,
  endExclusive: index + 1,
  messages: [message('user', String(index))],
  estimatedTokens,
});

const validProviderText = [
  '<analysis>',
  '先整理时间顺序、错误、当前工作和下一步。',
  '</analysis>',
  '<summary>',
  '## 1. 主要请求和意图',
  '请求',
  '',
  '## 2. 关键技术概念',
  '概念',
  '',
  '## 3. 文件和代码段',
  '文件',
  '',
  '## 4. 错误和修复',
  '错误',
  '',
  '## 5. 问题解决过程',
  '过程',
  '',
  '## 6. 所有用户消息',
  USER_MESSAGES_PLACEHOLDER,
  '',
  '## 7. 待办任务',
  '待办',
  '',
  '## 8. 当前工作',
  '工作',
  '',
  '## 9. 可能的下一步',
  '下一步',
  '</summary>',
].join('\n');

describe('compaction primitives', () => {
  it('exposes the exact public compaction contracts', async () => {
    expectTypeOf<CompactionRequest>().toEqualTypeOf<{
      trigger: 'auto' | 'manual';
      originalUserMessages: readonly string[];
    }>();
    expectTypeOf<CompactionResult>().toEqualTypeOf<
      | { outcome: 'compacted'; level: CompactionLevel; attempts: number }
      | { outcome: 'emergency_fallback'; level: 'emergency'; attempts: number }
      | {
          outcome: 'skipped';
          reason: 'below_threshold' | 'circuit_open' | 'no_history';
          level?: CompactionLevel;
          attempts: 0;
        }
      | { outcome: 'failed'; level: CompactionLevel; attempts: number }
    >();
    expectTypeOf<CompleteTurn>().toEqualTypeOf<{
      start: number;
      endExclusive: number;
      messages: readonly Message[];
      estimatedTokens: number;
    }>();
    expectTypeOf<SkillDefinitionSnapshot>().toEqualTypeOf<{
      id: string;
      renderedContent: string;
      lastUsedOrder: number;
    }>();

    const source: SkillContextSource = {
      async getUsedSkillDefinitions() {
        return [{ id: 'test', renderedContent: 'definition', lastUsedOrder: 1 }];
      },
    };
    await expect(source.getUsedSkillDefinitions()).resolves.toEqual([
      { id: 'test', renderedContent: 'definition', lastUsedOrder: 1 },
    ]);
  });

  it('uses fixed margins with strict boundaries for a non-20k context window', () => {
    expect(NORMAL_MARGIN).toBe(13_000);
    expect(USER_MESSAGES_PLACEHOLDER).toBe('{{ALL_USER_MESSAGES_VERBATIM}}');

    const select = (estimated: number): CompactionLevel | undefined =>
      selectCompactionLevel({
        estimated,
        contextWindow: 64_000,
        forceMargin: 6_000,
        emergencyMargin: 1_500,
      });

    expect(select(51_000)).toBeUndefined();
    expect(select(51_001)).toBe('normal');
    expect(select(58_000)).toBe('normal');
    expect(select(58_001)).toBe('force');
    expect(select(62_500)).toBe('force');
    expect(select(62_501)).toBe('emergency');
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
    expect(turns[0]).toEqual({
      start: 1,
      endExclusive: 6,
      messages: messages.slice(1, 6),
      estimatedTokens: Math.ceil('oneworkingABdone'.length / 4),
    });
    expect(turns[1]).toEqual({
      start: 6,
      endExclusive: 8,
      messages: messages.slice(6),
      estimatedTokens: Math.ceil('twook'.length / 4),
    });
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
    ).toThrow(/missing/);
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
    ).toThrow(/missing/);
  });

  it('counts the newest complete turns until either default retention limit is reached', () => {
    const turns = [2_000, 2_000, 2_000, 2_000, 2_000, 2_000].map(completeTurn);
    expect(countSummaryTurns(turns)).toBe(1);

    const tokenBounded = [6_000, 11_000, 1_000].map(completeTurn);
    expect(countSummaryTurns(tokenBounded)).toBe(1);
  });

  it('supports custom token and turn retention limits', () => {
    const turns = [1, 1, 1, 1].map(completeTurn);
    expect(countSummaryTurns(turns, 2, 99)).toBe(2);
    expect(countSummaryTurns(turns, 99, 2)).toBe(2);
  });

  it('drops the oldest turns without mutating the input', () => {
    const turns = [1, 2, 3, 4].map(completeTurn);
    const snapshot = [...turns];
    expect(dropOldestTurns(turns, 0.26)).toEqual(turns.slice(2));
    expect(dropOldestTurns(turns, 0)).toEqual(turns.slice(1));
    expect(turns).toEqual(snapshot);
  });

  it('locks ten-percent trimming to ceil and does not mutate either input', () => {
    const tenTurns = Array.from({ length: 10 }, (_, index) => completeTurn(index, index));
    const elevenTurns = Array.from({ length: 11 }, (_, index) => completeTurn(index, index));
    const tenSnapshot = [...tenTurns];
    const elevenSnapshot = [...elevenTurns];

    expect(dropOldestTurns(tenTurns, 0.1)).toEqual(tenTurns.slice(1));
    expect(dropOldestTurns(elevenTurns, 0.1)).toEqual(elevenTurns.slice(2));
    expect(tenTurns).toEqual(tenSnapshot);
    expect(elevenTurns).toEqual(elevenSnapshot);
  });

  it('renders every user message exactly in the fixed multiline wrapper', () => {
    const users = ['  keep <xml> & text  ', '', '重复', '重复'];
    const rendered = renderVerbatimUserMessages(users);
    expect(rendered).toBe(
      users
        .map(
          (body, index) =>
            `<user_message index="${index + 1}" length="${body.length}">\n${body}\n</user_message>`,
        )
        .join('\n'),
    );
  });

  it('accepts an external analysis draft and finalizes exactly nine numbered sections', () => {
    const userText = ['first', '  <second>  '];
    const result = finalizeSummary(validProviderText, userText);
    expect(result).toBeDefined();
    if (result === undefined) {
      throw new Error('合法摘要不应返回 undefined');
    }

    const headings = [...result.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      '1. 主要请求和意图',
      '2. 关键技术概念',
      '3. 文件和代码段',
      '4. 错误和修复',
      '5. 问题解决过程',
      '6. 所有用户消息',
      '7. 待办任务',
      '8. 当前工作',
      '9. 可能的下一步',
    ]);
    expect(result).not.toContain(USER_MESSAGES_PLACEHOLDER);
    expect(result).toContain('<user_message index="2" length="12">\n  <second>  \n</user_message>');
    expect(result).not.toMatch(/<analysis>/i);
  });

  it('ignores non-structural heading-like prose outside code fences', () => {
    const providerText = validProviderText.replace(
      '## 2. 关键技术概念\n概念',
      '## 2. 关键技术概念\n概念\n### 三级细节\n##正文',
    );

    expect(finalizeSummary(providerText, ['x'])).toBeDefined();
  });

  it.each([
    ['backtick', '```markdown', '```'],
    ['tilde', '~~~markdown', '~~~'],
  ])('ignores heading-like lines inside a %s code fence', (_name, openingFence, closingFence) => {
    const fencedCode = [
      openingFence,
      '## 安装',
      '## 1. 主要请求和意图',
      'npm install agentcode',
      closingFence,
    ].join('\n');
    const providerText = validProviderText.replace(
      '## 3. 文件和代码段\n文件',
      `## 3. 文件和代码段\n文件\n\n${fencedCode}`,
    );

    expect(finalizeSummary(providerText, ['x'])).toBeDefined();
  });

  it('rejects a duplicate fixed heading outside code fences', () => {
    const providerText = validProviderText.replace(
      '## 2. 关键技术概念',
      '## 1. 主要请求和意图\n重复章节\n\n## 2. 关键技术概念',
    );

    expect(finalizeSummary(providerText, ['x'])).toBeUndefined();
  });

  it('rejects an extra real H2 outside code fences', () => {
    const providerText = validProviderText.replace(
      '## 2. 关键技术概念\n概念',
      '## 2. 关键技术概念\n概念\n## 安装',
    );

    expect(finalizeSummary(providerText, ['x'])).toBeUndefined();
  });

  it('parses structure before injecting a Markdown heading from verbatim user text', () => {
    const userText = '  ## 用户原文标题\n正文  ';
    const result = finalizeSummary(validProviderText, [userText]);

    expect(result).toBeDefined();
    expect(result).toContain(`<user_message index="1" length="${userText.length}">\n${userText}\n</user_message>`);
  });

  it('preserves JavaScript replacement tokens in user messages character-for-character', () => {
    const userText = ['$&', '$$', '$`', "$'"];
    const result = finalizeSummary(validProviderText, userText);
    expect(result).toBeDefined();
    if (result === undefined) {
      throw new Error('合法摘要不应返回 undefined');
    }

    const sectionStart = result.indexOf('## 6. 所有用户消息\n') + '## 6. 所有用户消息\n'.length;
    const sectionEnd = result.indexOf('\n\n## 7. 待办任务', sectionStart);
    expect(result.slice(sectionStart, sectionEnd)).toBe(
      [
        '<user_message index="1" length="2">\n$&\n</user_message>',
        '<user_message index="2" length="2">\n$$\n</user_message>',
        '<user_message index="3" length="2">\n$`\n</user_message>',
        '<user_message index="4" length="2">\n$\'\n</user_message>',
      ].join('\n'),
    );
  });

  it('rejects malformed summaries and misplaced or duplicate placeholders', () => {
    expect(finalizeSummary(validProviderText.replace('## 8. 当前工作', '## 7. 待办任务'), ['x'])).toBeUndefined();
    expect(finalizeSummary(validProviderText.replace(USER_MESSAGES_PLACEHOLDER, 'missing'), ['x'])).toBeUndefined();
    expect(finalizeSummary(`${validProviderText}\n${USER_MESSAGES_PLACEHOLDER}`, ['x'])).toBeUndefined();
    expect(finalizeSummary(validProviderText.replace('请求', '<analysis>secret</analysis>'), ['x'])).toBeUndefined();

    const wrongSection = validProviderText
      .replace(USER_MESSAGES_PLACEHOLDER, '第六节没有占位符')
      .replace('## 5. 问题解决过程\n过程', `## 5. 问题解决过程\n过程\n${USER_MESSAGES_PLACEHOLDER}`);
    expect(finalizeSummary(wrongSection, ['x'])).toBeUndefined();
  });

  it('requires section six to contain only the placeholder plus whitespace', () => {
    expect(
      finalizeSummary(validProviderText.replace(USER_MESSAGES_PLACEHOLDER, `前置文本 ${USER_MESSAGES_PLACEHOLDER}`), [
        'x',
      ]),
    ).toBeUndefined();
    expect(
      finalizeSummary(validProviderText.replace(USER_MESSAGES_PLACEHOLDER, `${USER_MESSAGES_PLACEHOLDER} 后置文本`), [
        'x',
      ]),
    ).toBeUndefined();
  });

  it('returns undefined when the response contains two summary blocks', () => {
    expect(finalizeSummary(`${validProviderText}\n${validProviderText}`, ['x'])).toBeUndefined();
  });

  it('allows ordinary summary prose to contain the word undefined', () => {
    const result = finalizeSummary(
      validProviderText.replace('## 4. 错误和修复\n错误', '## 4. 错误和修复\n错误来自 undefined 变量'),
      ['x'],
    );
    expect(result).toContain('错误来自 undefined 变量');
  });

  it('creates summary, file, skill, and emergency recovery messages with fixed markers', () => {
    const summary = createSummaryMessages('final summary');
    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({ role: 'user' });
    expect(summary[0]!.content).toContain('final summary');
    expect(summary[1]).toMatchObject({ role: 'assistant' });
    expect(summary[1]!.content).toContain('[上下文已压缩]');

    expect(createFileRecoveryMessage([])).toBeUndefined();
    const files = createFileRecoveryMessage(['src/a.ts', 'docs/b.md']);
    expect(files?.role).toBe('user');
    expect(files?.content).toContain('src/a.ts');
    expect(files?.content).toContain('docs/b.md');
    expect(files?.content).toMatch(/重新读取|重读/);

    expect(createSkillRecoveryMessage([])).toBeUndefined();
    const skillContents = ['FIRST BODY', 'SECOND BODY'] as const;
    const skills = createSkillRecoveryMessage(skillContents);
    expect(skills?.role).toBe('user');
    expect(skills?.content.indexOf('FIRST BODY')).toBeLessThan(skills?.content.indexOf('SECOND BODY') ?? -1);

    const emergency = createEmergencyMessages([' a ', '<b>']);
    expect(emergency).toHaveLength(2);
    expect(emergency[0]).toMatchObject({ role: 'user' });
    expect(emergency[0]!.content).toContain('[紧急上下文恢复]');
    expect(emergency[0]!.content).toContain('<user_message index="1" length="3">\n a \n</user_message>');
    expect(emergency[1]).toMatchObject({ role: 'assistant' });
    expect(emergency[1]!.content).toContain('[上下文已紧急压缩]');
    expect(emergency[1]!.content).toContain('未生成摘要');
    expect(emergency[1]!.content).toMatch(/较早.*assistant\/tool.*丢失/);
  });
});
