# 上下文压缩增强 Tasks

## 绑定输入

- spec.md: 458a6e188c504c86297dcc1ec20ca332f4551663
- plan.md: c6f6cd5a8549ea586f107683f3ef1c941f303cc6

## 执行约束

- 每个任务严格按 RED -> GREEN -> REFACTOR 顺序执行。
- 只修改本任务列出的文件；额外缺陷先确认是否属于 Issue #54/#55。
- 每个测试先观察预期失败，再写最小实现并观察通过。
- 不修改 AgentLoop、OpenAI/Anthropic Provider 的公开协议或 YAML 配置 schema；T2 只在共享 fetch transport 内保留安全的输入过长语义。
- 不 push、不创建 PR、不合并仓库。

## 文件清单

| 操作 | 文件 | 任务 |
|---|---|---|
| 新建 | src/context/compaction.ts | T1 |
| 修改 | src/context/ContextManager.ts | T2、T3、T4 |
| 修改 | src/context/index.ts | T1、T2 |
| 修改 | src/providers/shared/fetchTransport.ts | T2 |
| 修改 | src/session/ChatSessionController.ts | T5 |
| 新建 | tests/unit/context/compaction.test.ts | T1 |
| 修改 | tests/unit/context/contextManager.test.ts | T2、T3、T4 |
| 修改 | tests/unit/providers/fetchTransport.test.ts | T2 |
| 修改 | tests/unit/session/ChatSessionController.test.ts | T5 |
| 修改 | docs/task08/checklist.md | T6 |

---

### T1：纯函数 compaction 边界与九段解析

**Files:**

- Create: src/context/compaction.ts
- Create: tests/unit/context/compaction.test.ts
- Modify: src/context/index.ts

- [ ] **Step 1：写水位选择先行测试**

在 tests/unit/context/compaction.test.ts 写入：

~~~typescript
import { describe, expect, it } from 'vitest';

import {
  selectCompactionLevel,
  type CompactionLevel,
} from '../../../src/context/compaction.js';

describe('selectCompactionLevel', () => {
  const select = (estimated: number): CompactionLevel | undefined =>
    selectCompactionLevel({
      estimated,
      contextWindow: 20_000,
      forceMargin: 5_000,
      emergencyMargin: 2_000,
    });

  it('严格按 normal、force、emergency 的大于边界选择', () => {
    expect(select(7_000)).toBeUndefined();
    expect(select(7_001)).toBe('normal');
    expect(select(15_000)).toBe('normal');
    expect(select(15_001)).toBe('force');
    expect(select(18_000)).toBe('force');
    expect(select(18_001)).toBe('emergency');
  });
});
~~~

- [ ] **Step 2：运行测试并确认 RED**

Run: npm test -- tests/unit/context/compaction.test.ts

Expected: FAIL，错误包含无法解析 src/context/compaction.js。

- [ ] **Step 3：创建公共类型和档位函数**

在 src/context/compaction.ts 实现：

~~~typescript
import type { ChatMessage } from '../providers/types.js';

export const NORMAL_MARGIN = 13_000;
export const USER_MESSAGES_PLACEHOLDER = '{{ALL_USER_MESSAGES_VERBATIM}}';

export type CompactionTrigger = 'auto' | 'manual';
export type CompactionLevel = 'normal' | 'force' | 'emergency';

export interface CompactionRequest {
  trigger: CompactionTrigger;
  originalUserMessages: readonly string[];
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

export function selectCompactionLevel(input: {
  estimated: number;
  contextWindow: number;
  forceMargin: number;
  emergencyMargin: number;
}): CompactionLevel | undefined {
  if (input.estimated > input.contextWindow - input.emergencyMargin) return 'emergency';
  if (input.estimated > input.contextWindow - input.forceMargin) return 'force';
  if (input.estimated > input.contextWindow - NORMAL_MARGIN) return 'normal';
  return undefined;
}
~~~

在 src/context/index.ts 重导出这些类型和函数。

- [ ] **Step 4：运行测试并确认 GREEN**

Run: npm test -- tests/unit/context/compaction.test.ts

Expected: 1 test passed。

- [ ] **Step 5：添加完整 turn 与工具配对测试**

构造一个 user turn，其中 assistant 含两个 tool calls，后接两个匹配 tool results；断言 splitCompleteTurns(messages, 0) 只返回一个 turn。把第二个 toolCallId 改成未知值，断言函数抛出包含 toolCallId 的错误。

~~~typescript
it('完整 turn 不拆分 parallel tool calls 和 results', () => {
  const messages = [
    { role: 'user' as const, content: '检查文件' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        { id: 'call-a', name: 'read_file', argumentsText: '{"path":"a.ts"}' },
        { id: 'call-b', name: 'read_file', argumentsText: '{"path":"b.ts"}' },
      ],
    },
    { role: 'tool' as const, toolCallId: 'call-a', toolName: 'read_file', content: '{}', isError: false },
    { role: 'tool' as const, toolCallId: 'call-b', toolName: 'read_file', content: '{}', isError: false },
    { role: 'assistant' as const, content: '完成' },
  ];

  const turns = splitCompleteTurns(messages, 0);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.messages).toEqual(messages);
});
~~~

- [ ] **Step 6：实现完整 turn、保留窗口和重试裁剪**

实现并导出：

~~~typescript
export function splitCompleteTurns(
  messages: readonly ChatMessage[],
  compactedPrefixLength: number,
): CompleteTurn[];

export function countSummaryTurns(
  turns: readonly CompleteTurn[],
  retainTokens = 10_000,
  retainTurns = 5,
): number;

export function dropOldestTurns(
  turns: readonly CompleteTurn[],
  ratio: number,
): CompleteTurn[];
~~~

要求：

- 非法 prefix length 抛 RangeError。
- 只从 prefix 后的 user 消息开始分组。
- 每条 tool result 都能在同 turn 之前的 assistant toolCalls 中找到。
- countSummaryTurns 从尾部按完整 turn 累加。
- dropOldestTurns 删除 Math.max(1, Math.ceil(turns.length * ratio)) 个 turn。

- [ ] **Step 7：添加九段解析和用户原文测试**

测试 Provider 文本同时包含 analysis 草稿和九段 summary，第 6 节放占位符。用户原文包含 Markdown 标题、XML 文本和首尾空格；断言最终摘要不含草稿，并逐字符包含原文。

同时覆盖：缺标题、标题顺序错误、占位符缺失或重复、存在两个 summary 块。

- [ ] **Step 8：实现九段校验和恢复消息渲染**

实现并导出：

~~~typescript
export function renderVerbatimUserMessages(messages: readonly string[]): string;
export function finalizeSummary(
  providerText: string,
  originalUserMessages: readonly string[],
): string | undefined;
export function createSummaryMessages(summary: string): ChatMessage[];
export function createFileRecoveryMessage(paths: readonly string[]): ChatMessage | undefined;
export function createSkillRecoveryMessage(contents: readonly string[]): ChatMessage | undefined;
export function createEmergencyMessages(originalUserMessages: readonly string[]): ChatMessage[];
~~~

固定边界文本分别包含 [上下文已压缩] 和 [上下文已紧急压缩]；紧急文本明确说明没有生成摘要且较早 assistant/tool 信息已丢弃。

- [ ] **Step 9：运行纯函数测试**

Run: npm test -- tests/unit/context/compaction.test.ts

Expected: all tests passed。

- [ ] **Step 10：提交 T1**

~~~bash
git add src/context/compaction.ts src/context/index.ts tests/unit/context/compaction.test.ts
git commit -m "feat(context): add compaction primitives"
~~~

---

### T2：ContextManager 档位、结构化结果和摘要重试

**Files:**

- Modify: src/context/ContextManager.ts
- Modify: tests/unit/context/contextManager.test.ts
- Modify: src/providers/shared/fetchTransport.ts
- Modify: tests/unit/providers/fetchTransport.test.ts

- [ ] **Step 1：写 options 与手动低水位先行测试**

新增测试：

- 非法 13000 > forceMargin > emergencyMargin >= 0 抛 RangeError。
- auto 低于 normal 线返回 skipped/below_threshold 且不调用 Provider。
- manual 在同一低水位仍调用 Provider。

~~~typescript
const result = await manager.compact(messages, {
  trigger: 'manual',
  originalUserMessages: ['原始需求'],
});
expect(result).toMatchObject({ outcome: 'compacted', level: 'normal', attempts: 1 });
~~~

- [ ] **Step 2：运行测试并确认 RED**

Run: npm test -- tests/unit/context/contextManager.test.ts

Expected: FAIL，compact 尚不存在或签名不匹配。

- [ ] **Step 3：扩展 options 和构造状态**

增加默认 force/emergency margin、空 Skill source、compactedPrefixLength 和结构化 compact 入口。删除旧 compress(messages, protectedIndices, manual) 和 protected index 重映射。

估算重置收敛为：

~~~typescript
private resetEstimate(messages: readonly ChatMessage[]): void {
  this._lastKnownTotalPromptTokens = 0;
  this._pendingChars = messages.reduce((sum, message) => sum + message.content.length, 0);
}
~~~

- [ ] **Step 4：写最大五次调用先行测试**

创建记录每次 request.messages 的 Provider：前四次返回 response.error，message 为 context length exceeded；第五次返回合法九段 summary。断言：

- 请求次数为 5。
- 第 2、3、4 次各比前一次少完整 10% turn。
- 第 5 次少当前 20%。
- 最终 attempts 为 5。

另写 authentication token invalid 错误，断言只调用 1 次。

- [ ] **Step 5：实现单次请求和重试编排**

在 ContextManager 内使用：

~~~typescript
type SummaryAttemptResult =
  | { kind: 'success'; summary: string; reusableSummary: string }
  | { kind: 'prompt_too_long' }
  | { kind: 'failure' };

private async requestSummaryOnce(
  messages: readonly ChatMessage[],
  originalUserMessages: readonly string[],
): Promise<SummaryAttemptResult>;
~~~

requestSummaryOnce(messages, originalUserMessages) 必须发送九段 Prompt、空 tools、toolChoice none、thinking disabled，为每次请求创建独立 timeout signal，收到 response.complete 后才调用 finalizeSummary。成功结果同时返回注入本轮用户原文的 summary，以及第 6 节为空、供下一轮 compact 使用的 reusableSummary。

callSummaryWithFallback 按 10%、10%、10%、20% 调用；非 prompt-too-long 立即结束。

共享 fetch transport 将 HTTP 400 的结构化 context-length 错误和 HTTP 413 安全映射为输入过长语义，同时限制错误体读取、取消未读流且不透传原始响应体；OpenAI/Anthropic Provider 的公开事件协议保持不变。

- [ ] **Step 6：实现 normal/force/emergency 准入与熔断**

- auto 低水位跳过。
- auto normal 且 circuit open 跳过。
- force、emergency、manual 绕过 circuit。
- 一组重试最终失败只计一次。
- manual 失败不计数。
- 摘要成功清零。

- [ ] **Step 7：运行 ContextManager 测试**

Run: npm test -- tests/unit/context/contextManager.test.ts

Expected: all tests passed。

- [ ] **Step 8：提交 T2**

~~~bash
git add src/context/ContextManager.ts tests/unit/context/contextManager.test.ts
git commit -m "feat(context): add compact levels and summary fallback"
~~~

---

### T3：最近文件路径和 Skill 恢复

**Files:**

- Modify: src/context/ContextManager.ts
- Modify: tests/unit/context/contextManager.test.ts

- [ ] **Step 1：写文件路径优先级先行测试**

通过 onMessagesAppended 注入 6 个 glob 路径、3 个 search 路径和 2 个 read_file 路径，并制造跨来源重复。compact 后断言恢复块：

- 只含 5 个路径。
- read_file 在最前，search 在 glob 前。
- 同一路径只出现一次。
- 不含 read_file content 正文。

- [ ] **Step 2：运行测试并确认 RED**

Run: npm test -- tests/unit/context/contextManager.test.ts

Expected: FAIL，onMessagesAppended 仍接收数字或未生成恢复块。

- [ ] **Step 3：实现消息观察和有界路径账本**

~~~typescript
onMessagesAppended(messages: readonly ChatMessage[]): void {
  this._pendingChars += messages.reduce((sum, message) => sum + message.content.length, 0);
  this.recordFileAccesses(messages);
}
~~~

要求：

- 按 assistant toolCalls id 与 tool result id 配对。
- 只解析成功结果。
- read_file 取 JSON path；search_code 取 matches[].path；glob_files 取 matches[]。
- 每个来源只保留最近记录并规范化去重。
- 不从普通字符串或卸载预览猜路径。

- [ ] **Step 4：写 Skill 来源和预算先行测试**

注入异步 SkillContextSource：三个定义乱序返回，断言最新定义先输出；总内容超过 25000 近似 tokens 时只截断最后可容纳定义；默认来源不生成 Skill 块。

- [ ] **Step 5：实现 Skill 选择和恢复块**

~~~typescript
private async getSkillRecoveryContents(): Promise<string[]>;
~~~

按 lastUsedOrder 降序，使用 remainingChars = 25000 * 4 预算。文件恢复块必须在 Skill 块之前。

- [ ] **Step 6：运行相关测试**

Run: npm test -- tests/unit/context/contextManager.test.ts

Expected: all tests passed。

- [ ] **Step 7：提交 T3**

~~~bash
git add src/context/ContextManager.ts tests/unit/context/contextManager.test.ts
git commit -m "feat(context): restore file paths and skill context"
~~~

---

### T4：紧急兜底、重复 compact 和原子性

**Files:**

- Modify: src/context/ContextManager.ts
- Modify: tests/unit/context/contextManager.test.ts
- Modify: tests/unit/context/compaction.test.ts

- [ ] **Step 1：写紧急机械兜底先行测试**

构造 8 个含 tool call/result 的完整 turn，estimated 超过 emergency 线，Provider 最终失败。断言：

- outcome 为 emergency_fallback。
- 前缀包含全部用户原文。
- 边界明确说明摘要失败和旧 assistant/tool 已删除。
- 尾部只保留最近 5 个完整 turn。
- 所有 tool result 均有对应 assistant tool call。
- estimated 等于最终消息字符数除以 4。

- [ ] **Step 2：写原子失败先行测试**

在 normal 和 force 水位返回非长度错误。调用前深拷贝 messages，调用后断言：

~~~typescript
expect(result.outcome).toBe('failed');
expect(messages).toStrictEqual(before);
~~~

- [ ] **Step 3：写重复 compact 先行测试**

第一次 compact 成功后追加至少 6 个新 turn，再次 compact。断言只有一个会话摘要、一个文件恢复块和一个 Skill 恢复块；旧恢复块不计为真实 turn；第 6 节仍含全部用户原文。

- [ ] **Step 4：实现临时构造、prefix length 和机械路径**

- 所有 replacement 先在新数组构建。
- 只有成功才调用一次 messages.splice。
- 更新 compactedPrefixLength 为实际合成消息数。
- 二次 compact 的上一代摘要输入移除第 6 节用户原文。
- emergency 自动路径摘要失败增加一次失败计数但不清零；manual 不增加。

- [ ] **Step 5：运行 context 全部测试**

Run: npm test -- tests/unit/context/

Expected: compaction、contextManager、contextWindow 测试全部通过。

- [ ] **Step 6：提交 T4**

~~~bash
git add src/context/ContextManager.ts tests/unit/context/compaction.test.ts tests/unit/context/contextManager.test.ts
git commit -m "feat(context): add emergency and repeat compaction"
~~~

---

### T5：Controller /compact 与自动集成

**Files:**

- Modify: src/session/ChatSessionController.ts
- Modify: tests/unit/session/ChatSessionController.test.ts

- [ ] **Step 1：更新 ContextManager mock**

~~~typescript
const compactCalls: Array<{ trigger: string; originalUserMessages: readonly string[] }> = [];
const mockContextManager = {
  onTokenUsage: () => {},
  onMessagesAppended: () => {},
  offloadToolResults: async () => {},
  compact: async (_messages: unknown, request: { trigger: string; originalUserMessages: readonly string[] }) => {
    compactCalls.push(request);
    return { outcome: 'compacted', level: 'normal', attempts: 1 };
  },
} as any;
~~~

- [ ] **Step 2：写 /compact 命令先行测试**

覆盖：

- 极低水位时仍调用 compact。
- 调用顺序为 offload -> compact。
- trigger 为 manual。
- /compact 不进入 UI transcript。
- /compress 不调用 compact，并作为普通 user 文本进入 Provider request。
- no_history、failed、emergency_fallback 的中文 notice。

- [ ] **Step 3：写自动路径和用户原文来源测试**

连续完成两个历史 turn，再提交第三个 turn。断言自动 compact 在 AgentLoop Provider 调用前发生，trigger 为 auto，originalUserMessages 只含前两个已提交 user 正文，不含当前第三个 user；Controller 不读取 estimated、contextWindow 或 circuitOpen。

- [ ] **Step 4：运行测试并确认 RED**

Run: npm test -- tests/unit/session/ChatSessionController.test.ts

Expected: FAIL，当前仍识别 /compress 且使用旧 compress。

- [ ] **Step 5：实现 Controller 集成**

- 删除 protectedContextIndices。
- parseCommand 改为 isCompact，只匹配 /compact。
- 手动路径先 F2，再无条件调用 compact。
- 自动路径 F2 后无条件调用 compact。
- complete/fail turn 把实际 appended Provider 消息数组传给 onMessagesAppended。
- 新增 getOriginalUserMessages，从 contextMessages 提取已提交 user 正文。
- 上下文过长 notice 改为建议 /compact。

- [ ] **Step 6：运行 session 与 context 测试**

Run: npm test -- tests/unit/session/ChatSessionController.test.ts tests/unit/context/

Expected: all tests passed。

- [ ] **Step 7：运行类型检查**

Run: npm run typecheck

Expected: exit 0，0 TypeScript errors。

- [ ] **Step 8：提交 T5**

~~~bash
git add src/session/ChatSessionController.ts tests/unit/session/ChatSessionController.test.ts
git commit -m "feat(session): replace compress with compact"
~~~

---

### T6：文档绑定和完整验证

**Files:**

- Modify: docs/task08/checklist.md
- Verify: docs/task08/spec.md
- Verify: docs/task08/plan.md
- Verify: docs/task08/tasks.md

- [ ] **Step 1：更新 checklist 文档绑定**

使用 git hash-object 计算 spec、plan、tasks 内容 hash，写入 checklist 顶部。确认四份文档不存在旧手动 3000 水位、旧四段 Prompt、protectedContextIndices 或把 /compress 描述为命令的条目。

- [ ] **Step 2：运行静态检查**

Run: npm run lint

Expected: exit 0，无 Biome errors 或 warnings。

Run: npm run typecheck

Expected: exit 0，0 TypeScript errors。

- [ ] **Step 3：运行聚焦测试**

Run: npm test -- tests/unit/context/ tests/unit/session/ChatSessionController.test.ts

Expected: all selected test files passed。

- [ ] **Step 4：运行全量测试和构建**

Run: npm test

Expected: all test files passed。

Run: npm run build

Expected: exit 0，dist/cli/main.js 构建成功。

- [ ] **Step 5：运行 E2E**

Run: npm run e2e:tmux

Expected: 环境存在 psmux/tmux 时通过；不可用时记录实际错误为环境阻塞。

- [ ] **Step 6：检查变更范围**

Run: git status --short

Expected: 仅出现本计划文件清单中的变更。

Run: git diff --check

Expected: exit 0，无空白错误。

- [ ] **Step 7：提交文档和验证记录**

~~~bash
git add docs/task08/spec.md docs/task08/plan.md docs/task08/tasks.md docs/task08/checklist.md
git commit -m "docs(task08): align compact implementation docs"
~~~
