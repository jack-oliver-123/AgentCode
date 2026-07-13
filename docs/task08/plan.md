# 上下文管理 Plan

## 已批准输入

- spec.md: `4df5c77bb6cf5974ad02b6e096043275481ba9ad`

## 方案摘要

在现有 `ChatSessionController` 上叠加一个 `ContextManager` 辅助类，以"Controller 持有 providerContext 数组，ContextManager 以参数形式接收"的就地修改模式集成。不引入新的状态共享机制，不改变 AgentLoop / Provider 接口。

未采用的方案：
- ContextManager 内部持有 providerContext 引用 → 会使 ContextManager 与 Controller 生命周期耦合，测试时需构造完整 Controller
- 将压缩逻辑嵌入 AgentLoop → AgentLoop 是无状态 generator，职责边界清晰，不应引入会话级状态

## 组件与职责

| 组件 | 职责 | 依赖 |
|------|------|------|
| `ContextManager` | token 估算、工具结果卸载、LLM 摘要、熔断 | `ChatModelProvider`, `fs/promises` |
| `ChatSessionController`（修改） | 构造 ContextManager、在 3 个集成点调用其方法、扩展 parseCommand | `ContextManager` |
| `lookupContextWindow` | model 名前缀查表，返回 contextWindow 大小 | 无 |

## 交互与数据流

```text
submitUserText
  │
  ├─ parseCommand() → { mode, actualText, isCompress? }
  │     isCompress=true 时：
  │       不调用 setLoopMode（/compress 不切换会话模式）
  │       在 this.messages.push(userMessage) 之前拦截，/compress 不写入 TUI 历史
  │       └─ estimated > contextWindow - 3000?
  │             YES → compress(providerContext, protectedIndices, true)
  │                     → 成功(true):  notice='上下文已压缩', yield state, return
  │                     → 失败(false): notice='上下文压缩失败，请稍后重试', yield state, return
  │             NO  → notice='上下文尚未到压缩阈值', yield state, return
  │     isCompress=false 时：
  │       this.setLoopMode(mode)（保留现有逻辑）
  │       this.messages.push(userMessage)（保留现有逻辑）
  │
  ├─ offloadToolResults(providerContext)      ← F2 卸载
  │     对 role:'tool' 消息就地修改 content
  │
  ├─ !circuitOpen && estimated > contextWindow - 13000?
  │     └─ compress(providerContext, protectedIndices) ← F3 自动摘要
  │           （详见"核心算法 - F3 压缩流程"）
  │
  └─ runAgentLoop(...)
        loop.completed → completeTurn
          // push 前记录 user 消息的插入下标
          const userIdx = providerContext.length;   // 用户消息将落在此下标
          providerContext.push(toProviderMessage(userMessage), ...turnMessages, assistantMsg);
          protectedContextIndices.add(userIdx);     // 只保护 user 消息下标
          onMessagesAppended(userMsg.content.length + turnMsgsChars + finalText.length)
        failTurn（有条件 push user 时，在现有 guard 内）
          const userIdx = providerContext.length;
          providerContext.push(toProviderMessage(userMessage));
          protectedContextIndices.add(userIdx);
          onMessagesAppended(toProviderMessage(userMessage).content.length)
        token.usage → onTokenUsage(event.totalPromptTokens)
```

## 核心算法

### F1：token 估算

```
estimated = lastKnownTotalPromptTokens + Math.ceil(pendingChars / 4)
```

- `onTokenUsage(total)` → `lastKnownTotalPromptTokens = total; pendingChars = 0`
- `onMessagesAppended(chars)` → `pendingChars += chars`
- 初始值均为 0

### F2：轮级卸载中的 turn 边界定位

`offloadToolResults(messages)` 遍历方式：

```
以 role:'user' 消息作为 turn 起始标记。
从头到尾扫描 messages，遇到 role:'user' 时记为新 turn 起点。
每个 turn 范围 = [turn起点, 下一个role:'user'起点 - 1]（末尾 turn 含到数组末尾）。
对每个 turn：
  1. 先对 role:'tool' 消息执行单条卸载（content 字节 > offloadThresholdBytes）
  2. 统计该 turn 内所有 role:'tool' 消息 content 字节合计
  3. 若合计 > turnOffloadThresholdBytes，按剩余字节从大到小依次卸载直到合计 ≤ 阈值
```

### F3：压缩流程

**1. 保留窗口计算（求 N）**

```
从 messages 尾部往前扫描，以 role:'user' 消息作为 turn 边界：
- 累计扫描字符数 / 4 作为 token 近似值
- 每遇到 role:'user' 且其前面所有消息均已纳入，turn 数 +1
- 条件：累计 token >= 10000 OR 已回溯 turn 数 >= 5，停止

retainFrom = 停止时的消息下标（含该下标）
N = retainFrom（待摘要区 = messages[0..N-1]，保留区 = messages[N..]）
若 N < 2，跳过摘要返回 true。
```

**2. LLM 摘要请求**

完整请求结构（对照 spec F3）：

```typescript
const request: ProviderRequest = {
  model: this.model,                    // 来自构造参数
  system: SUMMARY_SYSTEM_PROMPT,        // 固定文本，见 spec F3
  tools: [],
  toolChoice: 'none',
  thinking: { enabled: false },
  messages: [
    ...messages.slice(0, N),            // 待摘要区原始消息
    { role: 'user', content: SUMMARY_INSTRUCTION }, // 指令消息，见 spec F3
  ],
  signal: AbortSignal.timeout(this.options.timeoutMs),
};
```

`SUMMARY_SYSTEM_PROMPT` 和 `SUMMARY_INSTRUCTION` 为 spec F3 中定义的固定字符串，抽取为模块级常量。

**3. 应用摘要后状态重置**

```typescript
// compress() 内部，摘要成功后：
messages.splice(0, N);
messages.unshift(summaryMsg, boundaryMsg);

// 重置 token 估算（全量重扫，不通过 onMessagesAppended）
this._lastKnownTotalPromptTokens = 0;
this._pendingChars = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);

// 下标重映射
const newIndices = new Set<number>();
for (const i of protectedIndices) {
  if (i >= N) newIndices.add(i - N + 2);
  // i < N 的受保护消息随摘要区被移除，不保留
}
protectedIndices.clear();
for (const i of newIndices) protectedIndices.add(i);
```

### F5：熔断规格

```
consecutiveSummaryFailures: number  // ContextManager 内部私有字段，初始 0

失败（stream 报错、response.error、无 <summary>）：
  if (!manual) consecutiveSummaryFailures++;   // 手动路径不计入
  return false;

成功：
  consecutiveSummaryFailures = 0;
  return true;

circuitOpen = consecutiveSummaryFailures >= 3
// 仅阻止自动触发；compress(messages, indices, true) 不受影响
```

## 接口与数据结构

### ChatSessionController 新增字段

```typescript
// 新增私有字段（在构造函数中初始化）
private readonly contextManager: ContextManager;
private readonly protectedContextIndices: Set<number> = new Set();
```

`contextManager` 在 `constructor` 中构造：

```typescript
this.contextManager = new ContextManager(options.provider, config.model, {
  contextWindow: lookupContextWindow(config.model),
  offloadThresholdBytes: 8192,
  turnOffloadThresholdBytes: 32768,
  cacheDir: path.join(this.cwd, '.agentcode', 'context-cache'),
  timeoutMs: config.request.timeoutMs,
});
```

`cacheDir` 由已有的 `this.cwd`（工作目录）拼接 `.agentcode/context-cache` 得出，目录自动创建逻辑由 `ContextManager` 内部处理（`fs.mkdir` recursive）。

**测试注入：** `ChatSessionControllerOptions` 新增可选字段 `contextManager?: ContextManager`，Constructor 优先使用注入值；未注入时自行构造。这样现有 Controller 测试无需改动，新测试可注入 mock。

```typescript
// ChatSessionControllerOptions 新增：
contextManager?: ContextManager;
```

### ContextManagerOptions

```typescript
interface ContextManagerOptions {
  contextWindow: number;             // 模型窗口 tokens
  offloadThresholdBytes: number;     // 单条卸载阈值，默认 8192
  turnOffloadThresholdBytes: number; // 轮级卸载阈值，默认 32768
  cacheDir: string;                  // 绝对路径，由 Controller 以 cwd + '.agentcode/context-cache' 填充
  timeoutMs: number;                 // 来自 config.request.timeoutMs
}
```

### ContextManager（公开接口）

`ChatMessage` 指 `src/providers/types.ts` 中导出的 provider 层类型（`import type { ChatMessage } from '../providers/types.js'`），**不是** `src/session/types.ts` 中的会话层同名类型。

```typescript
// ChatMessage = ProviderTextMessage | ProviderAssistantToolCallMessage | ProviderToolResultMessage
//   来自 src/providers/types.ts，不是 src/session/types.ts
class ContextManager {
  constructor(provider: ChatModelProvider, model: string, options: ContextManagerOptions);

  // F1 集成：applyAgentLoopEvent token.usage case 调用
  onTokenUsage(totalPromptTokens: number): void;

  // F1 集成：completeTurn / failTurn push 后调用
  onMessagesAppended(chars: number): void;

  // 当前估算值（只读）
  get estimated(): number;

  // F2：就地修改 messages，将大工具结果替换为预览
  offloadToolResults(messages: ChatMessage[]): Promise<void>;

  // F3：就地修改 messages，执行 LLM 摘要压缩
  // manual=true 时 safetyMargin=3000（仍有水位检查）；false/省略 时 safetyMargin=13000
  // 待摘要区 < 2 条时跳过并返回 true（非失败）
  compress(
    messages: ChatMessage[],
    protectedIndices: Set<number>,
    manual?: boolean,
  ): Promise<boolean>;

  // F5：consecutiveSummaryFailures >= 3
  get circuitOpen(): boolean;
}
```

### parseCommand 返回类型变更

```typescript
// 原：{ mode: AgentLoopMode; actualText: string }
// 新：
{ mode: AgentLoopMode; actualText: string; isCompress?: boolean }
```

### lookupContextWindow

```typescript
function lookupContextWindow(model: string): number
// 最长前缀优先；位于 src/context/contextWindow.ts
```

## 文件组织

| 操作 | 路径 | 目的 |
|------|------|------|
| 新建 | `src/context/ContextManager.ts` | 压缩逻辑主体 |
| 新建 | `src/context/contextWindow.ts` | model 窗口查表 |
| 新建 | `src/context/index.ts` | 导出 ContextManager, lookupContextWindow |
| 修改 | `src/session/ChatSessionController.ts` | 集成 ContextManager，扩展 parseCommand |
| 新建 | `tests/unit/context/contextManager.test.ts` | ContextManager 单元测试 |
| 新建 | `tests/unit/context/contextWindow.test.ts` | 查表单元测试 |

## 兼容性与迁移

- 所有现有工具、Provider、AgentLoop 接口不变
- `providerContext` 继续是 `ProviderChatMessage[]`（即 `providers/types.ts` 的 `ChatMessage[]`），数组结构不变，只是元素 content 可能被替换或数组被截断/扩充
- 无配置文件 schema 变更（ContextManagerOptions 由 Controller 在构造时直接填充）
- 现有测试不需要修改（Controller 测试中 contextManager 不存在时自动跳过集成点，或通过注入接口保持兼容）

## 验证策略

- 单元验证：
  - `lookupContextWindow`：前缀优先级，边界 model 名，默认值
  - `ContextManager.offloadToolResults`：单条 > 8KB 触发，< 8KB 不触发，轮级合并卸载，文件写入内容
  - `ContextManager.compress`：保留窗口计算，摘要请求字段，成功/失败路径，熔断计数，safetyMargin 差异，protectedIndices 截断，下标重映射
  - `ContextManager.estimated`：onTokenUsage 重置，onMessagesAppended 累加
  - 命令：`npm test -- tests/unit/context/`
- 集成验证：
  - `ChatSessionController` 收到 `token.usage` 事件后 estimated 正确更新
  - `/compress` 命令不残留在 messages[]
  - 命令：`npm test -- tests/unit/session/`
- 端到端验证：
  - `npm run e2e:tmux`（需 psmux/tmux）

## 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|------|------|------|------|
| providerContext 就地修改导致竞态（理论上单线程） | 消息错乱 | submitUserText 串行执行，无并发写入 | 回退 ChatSessionController 改动 |
| 摘要 LLM 调用消耗额外 token | 费用增加 | 熔断 3 次上限；手动触发用户主动 | 直接禁用 F3 路径 |
| 卸载文件路径泄漏 secret | 安全风险 | cacheDir 在 .agentcode/ 下，已在 .gitignore 中 | 删除 context-cache/ 目录 |
| 估算误差导致频繁摘要 | 性能下降 | 13K 安全余量；摘要成功后全量重扫重置 | 调大 safetyMargin 常量 |
| ChatMessage 类型歧义（session vs providers） | 编译错误 | N4 已明确指向 providers/types.ts；导入语句加注释 | 无需回滚，编译期即暴露 |
