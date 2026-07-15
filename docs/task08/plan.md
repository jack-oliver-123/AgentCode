# 上下文压缩增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Issue #54/#55：实现 `/compact`、三档自动压缩、九段式两阶段摘要、用户原文与关键上下文恢复、超长降级重试和紧急机械兜底。

**Architecture:** 保留 `ChatSessionController -> ContextManager -> ChatModelProvider` 现有分层。新增一个 `src/context/compaction.ts` 纯函数模块处理水位、完整 turn、九段解析和恢复消息构造；`ContextManager` 负责会话状态、Provider stream、熔断和原子数组替换，Controller 只负责触发和 UI notice。

**Tech Stack:** TypeScript 5.9、ESM、Node.js 20、Vitest 4、Biome。

---

## 已批准输入

- spec.md: `458a6e188c504c86297dcc1ec20ca332f4551663`
- GitHub Issues: `#54`, `#55`

## 方案选择

采用“单一 compact 入口 + 纯函数边界处理”的务实方案。

未采用：

- 把全部逻辑继续堆入 `ContextManager.ts`：改动最少，但九段解析、turn 边界、路径恢复和紧急渲染无法独立测试。
- 引入完整 `ProviderContextState` 和不可变状态机：长期边界最清晰，但会扩大 Controller 中所有 `providerContext` 访问点的改动。

本方案不修改 AgentLoop、OpenAI/Anthropic Provider 的公开协议和配置文件 schema。T2 会修改共享 fetch transport，使 HTTP 错误在不泄露原始响应体的前提下保留安全的“输入过长”语义，供现有 Provider 错误协议和 compact 重试复用。

## 文件结构

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `src/context/compaction.ts` | 纯函数：档位选择、完整 turn、重试裁剪、九段校验、用户原文注入、恢复消息渲染 |
| 修改 | `src/context/ContextManager.ts` | token/F2 状态、路径账本、Provider 摘要调用、重试编排、熔断、原子 compact |
| 修改 | `src/context/index.ts` | 导出 compaction 公共类型和 Skill 来源类型 |
| 修改 | `src/providers/shared/fetchTransport.ts` | T2：安全映射 HTTP 输入过长错误、限制错误体读取并保留取消语义，不改变 Provider 公开协议 |
| 修改 | `src/session/ChatSessionController.ts` | `/compact`、自动触发、用户原文来源、notice 映射；删除 protected indices |
| 新建 | `tests/unit/context/compaction.test.ts` | 纯算法单测 |
| 修改 | `tests/unit/context/contextManager.test.ts` | Provider 调用、重试、恢复、熔断、紧急兜底单测 |
| 修改 | `tests/unit/providers/fetchTransport.test.ts` | T2：共享 transport 输入过长、安全错误体和流取消回归测试 |
| 修改 | `tests/unit/session/ChatSessionController.test.ts` | 命令和集成时序单测 |
| 修改 | `docs/task08/tasks.md` | TDD 执行步骤 |
| 修改 | `docs/task08/checklist.md` | Issue #54/#55 行为验收 |

## 公共类型

在 `src/context/compaction.ts` 定义并由 `src/context/index.ts` 重导出：

```typescript
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

export interface SkillDefinitionSnapshot {
  id: string;
  renderedContent: string;
  lastUsedOrder: number;
}

export interface SkillContextSource {
  getUsedSkillDefinitions(): Promise<readonly SkillDefinitionSnapshot[]>;
}
```

`ContextManagerOptions` 扩展为：

```typescript
export interface ContextManagerOptions {
  contextWindow: number;
  offloadThresholdBytes: number;
  turnOffloadThresholdBytes: number;
  cacheDir: string;
  timeoutMs: number;
  forceMargin?: number;
  emergencyMargin?: number;
  skillContextSource?: SkillContextSource;
  _writeFile?: (path: string, data: string, encoding: string) => Promise<void>;
}
```

默认值：

```typescript
const NORMAL_MARGIN = 13_000;
const DEFAULT_FORCE_MARGIN = 5_000;
const DEFAULT_EMERGENCY_MARGIN = 2_000;
const EMPTY_SKILL_CONTEXT_SOURCE: SkillContextSource = {
  async getUsedSkillDefinitions() {
    return [];
  },
};
```

构造时若不满足 `NORMAL_MARGIN > forceMargin > emergencyMargin >= 0`，抛出 `RangeError`。

## `compaction.ts` 设计

### 完整 turn

```typescript
export interface CompleteTurn {
  start: number;
  endExclusive: number;
  messages: readonly ChatMessage[];
  estimatedTokens: number;
}

export function splitCompleteTurns(
  messages: readonly ChatMessage[],
  compactedPrefixLength: number,
): CompleteTurn[];
```

规则：

- 从 `compactedPrefixLength` 之后开始识别真实 turn。
- `role: 'user'` 开始新 turn，直到下一条真实 user 之前。
- turn 内 assistant `toolCalls[].id` 必须与 tool `toolCallId` 配平。
- 如果前缀长度非法或出现孤立 tool result，返回可诊断错误；ContextManager 本次 compact 返回失败且不修改数组。

### 档位选择

```typescript
export function selectCompactionLevel(input: {
  estimated: number;
  contextWindow: number;
  forceMargin: number;
  emergencyMargin: number;
}): CompactionLevel | undefined;
```

严格按 emergency、force、normal 顺序检查 `>`；低于 normal 线返回 `undefined`。manual 在 `undefined` 时由 ContextManager 强制按 normal 执行。

### 摘要区与保留区

```typescript
export function countSummaryTurns(
  turns: readonly CompleteTurn[],
  retainTokens?: number,
  retainTurns?: number,
): number;
```

默认从尾部保留约 10000 tokens 或最近 5 个完整 turn，返回应进入摘要区的 turn 数。没有摘要 turn 时返回 0。

### 重试裁剪

```typescript
export function dropOldestTurns(
  turns: readonly CompleteTurn[],
  ratio: number,
): CompleteTurn[];
```

删除 `max(1, ceil(currentTurns.length * ratio))` 个最旧完整 turn。结果为空时不再调用 Provider。

### 九段摘要解析

```typescript
export const USER_MESSAGES_PLACEHOLDER = '{{ALL_USER_MESSAGES_VERBATIM}}';

export function finalizeSummary(
  providerText: string,
  originalUserMessages: readonly string[],
): string | undefined;
```

实现顺序：

1. 提取唯一 `<summary>...</summary>`。
2. 校验九个 `## N.` 标题按 1 到 9 顺序各出现一次。
3. 校验第 6 节只含唯一用户消息占位符。
4. 用 `renderVerbatimUserMessages()` 输出替换占位符。
5. 返回不含 `<analysis>` 的完整 `<summary>` 正文；任一校验失败返回 `undefined`。

用户原文包装格式固定，正文不 trim、不转义：

```text
<user_message index="1" length="{content.length}">
{content}
</user_message>
```

### 合成消息

```typescript
export function createSummaryMessages(summary: string): ChatMessage[];
export function createFileRecoveryMessage(paths: readonly string[]): ChatMessage | undefined;
export function createSkillRecoveryMessage(contents: readonly string[]): ChatMessage | undefined;
export function createEmergencyMessages(originalUserMessages: readonly string[]): ChatMessage[];
```

正常摘要前缀顺序固定为 summary user、boundary assistant、可选 file user、可选 Skill user。紧急前缀使用独立的恢复 user 和真实机械截断 boundary，不伪称旧历史已摘要。

### 旧合成前缀

`ContextManager` 维护 `_compactedPrefixLength`。下一次 compact：

- `splitCompleteTurns()` 不把旧前缀计为 turn。
- 从旧 summary 中移除第 6 节原文块，作为上一代摘要输入。
- 旧文件和 Skill 恢复块不再次送入 LLM。
- 新 compact 成功后用新前缀替换旧前缀及新摘要 turn。

## `ContextManager` 设计

### 新增状态

```typescript
private readonly forceMargin: number;
private readonly emergencyMargin: number;
private readonly skillContextSource: SkillContextSource;
private _compactedPrefixLength = 0;
private _reusableSummary: string | undefined;
private _fileAccessSequence = 0;
private readonly recentFileAccesses: FileAccessRecord[] = [];
```

`FileAccessRecord` 为私有类型：

```typescript
interface FileAccessRecord {
  path: string;
  source: 'read_file' | 'search_code' | 'glob_files';
  sequence: number;
}
```

每个来源只保留最近的少量去重项，避免账本无界增长。

### F1 接口调整

把 `onMessagesAppended(chars)` 改为：

```typescript
onMessagesAppended(messages: readonly ChatMessage[]): void;
```

该方法同时累计 `content.length` 并解析新 assistant/tool 消息中的结构化文件路径。Controller 在 push 前构造一次 `appendedMessages`，push 后把同一数组传入。

### 单次摘要请求

```typescript
type SummaryAttemptResult =
  | { kind: 'success'; summary: string; reusableSummary: string }
  | { kind: 'prompt_too_long' }
  | { kind: 'failure' };

private async requestSummaryOnce(
  messages: readonly ChatMessage[],
  originalUserMessages: readonly string[],
): Promise<SummaryAttemptResult>;
```

判定规则：

- `response.error.error.message` 或 caught `Error.message` 匹配 `context window`、`context length`、`maximum ... token`、`token limit`、`prompt too long`、`input too long` 时返回 `prompt_too_long`。
- 不以裸 `token` 关键词判断，避免把认证 token 错误当作超长。
- timeout、其他 Provider 错误、stream 未 complete、缺失/非法九段 summary 返回 `failure`。
- 每次请求创建独立 AbortSignal。
- 成功时同时生成含本轮全部用户原文的 `summary`，以及第 6 节为空的 `reusableSummary`；后者只用于下一轮 compact 的上一代摘要输入。

### 最多五次调用

```text
attempt 1: 完整摘要 turns
attempt 2: 丢当前最旧 10%
attempt 3: 再丢当前最旧 10%
attempt 4: 再丢当前最旧 10%
attempt 5: 再丢当前最旧 20%
```

任何非 prompt-too-long 失败立即停止。`attempts` 记录真实 Provider 调用次数。

### 路径选择

`selectRecentFilePaths()` 依次读取 read_file、search_code、glob_files 三组记录；每组 sequence 降序，跨组规范化去重，取前 5 个。输出只含路径。

### Skill 预算

调用可选 `skillContextSource`，按 `lastUsedOrder` 降序。预算按 `ceil(chars / 4)` 近似 25000 tokens；最后一个定义超预算时按剩余字符容量截断，之后停止。

### 原子 compact

```typescript
async compact(
  messages: ChatMessage[],
  request: CompactionRequest,
): Promise<CompactionResult>;
```

流程：

1. 计算档位；auto 低水位或 auto normal 熔断时返回 skipped。
2. 分离旧合成前缀和完整真实 turns。
3. 计算摘要 turns；为 0 时返回 `no_history`。
4. 从会话文件访问账本选择最近路径，并获取 Skill snapshots。
5. 发起九段摘要及超长降级重试。
6. 成功时在临时数组构造新前缀 + 原保留 turns。
7. emergency 最终失败时构造用户原文恢复 + 文件/Skill + 最近 5 完整 turns。
8. 仅成功结果使用一次 `messages.splice()` 原子替换，并更新 `_compactedPrefixLength` 与 token 估算。
9. normal/force 最终失败保持数组、prefix length 和估算不变。
10. 按 spec F9 更新熔断计数。

## Controller 集成

### 删除旧保护机制

删除：

- `protectedContextIndices` 字段。
- complete/fail turn 中记录 user 下标的逻辑。
- `compress(messages, indices, manual)` 调用。

用户原文改由完整 `contextMessages` 提供：

```typescript
private getOriginalUserMessages(): string[] {
  return this.contextMessages
    .filter(message => message.role === 'user')
    .map(message => toProviderMessage(message).content);
}
```

### `/compact`

`parseCommand()` 返回 `isCompact?: boolean`，只匹配 `/^\/compact\b/i`。

手动路径：

```typescript
await this.contextManager.offloadToolResults(this.providerContext);
const result = await this.contextManager.compact(this.providerContext, {
  trigger: 'manual',
  originalUserMessages: this.getOriginalUserMessages(),
});
```

`/compact` 不写入 UI 历史；`/compress` 作为普通文本进入 AgentLoop。

### 自动路径

F2 后无条件委托 ContextManager：

```typescript
await this.contextManager.compact(this.providerContext, {
  trigger: 'auto',
  originalUserMessages: this.getOriginalUserMessages(),
});
```

Controller 不再读取 `estimated`、`contextWindow` 或 `circuitOpen` 做策略判断。

### notice 映射

| 结果 | notice |
|---|---|
| `compacted` | `上下文已压缩` |
| `emergency_fallback` | `上下文已紧急压缩，摘要失败后已使用机械兜底` |
| `skipped/no_history` | `没有可压缩的历史` |
| `failed` | `上下文压缩失败，请稍后重试` |

自动路径不展示成功 notice；现有 Provider 上下文过长错误提示改为 `/compact`。

## 构建顺序

1. T1：纯函数 compaction 边界与九段解析。
2. T2：ContextManager 档位、重试和结构化结果。
3. T3：文件路径与 Skill 恢复。
4. T4：紧急兜底、重复 compact 和熔断组合。
5. T5：Controller `/compact` 与自动集成。
6. T6：文档绑定、全量验证与 E2E。

每项按 `docs/task08/tasks.md` 的 RED -> GREEN -> REFACTOR -> 验证步骤执行。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 用户原文含 Markdown/XML 标记破坏九段解析 | 先解析模型占位符，再插入原文；插入后不再解析 |
| 多次 compact 嵌套旧恢复块 | `_compactedPrefixLength` 显式排除旧合成前缀 |
| F2 后无法解析原工具 JSON | 在 `onMessagesAppended` 时记录路径，不从卸载预览猜测 |
| 裸 `token` 误判认证错误 | 使用长度语义组合模式，不匹配单独 token |
| normal/force 失败导致半改写 | 临时构造，成功后单次 splice |
| 紧急恢复仍超窗 | 明确保留所有用户原文的产品约束和残余风险，不静默删除 |
| ContextManager 继续变大 | 把纯算法集中到 `compaction.ts`，Manager 只保留状态和 I/O |

## 验证命令

```bash
npm test -- tests/unit/context/compaction.test.ts
npm test -- tests/unit/context/contextManager.test.ts
npm test -- tests/unit/session/ChatSessionController.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e:tmux
```

E2E 依赖 psmux/tmux；不可用时记录环境阻塞，不声称通过。
