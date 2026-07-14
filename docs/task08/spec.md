# 上下文管理 Spec

## 背景

AgentCode 的 `ChatSessionController` 在 `providerContext` 数组中累积跨 turn 的 Provider 消息（用户文本、工具调用、工具结果、助手回答）。工具结果（`role: 'tool'`）往往是最大的 token 占用方：一次 `read_file` 返回几千行代码，几轮下来 `providerContext` 很快逼近模型的上下文窗口上限，触发 Provider 侧错误或无声截断。

当前无任何压缩机制，长时间使用或处理大文件时必然溢出。

## 目标

- 在有限 token 预算内支持长会话持续运行，不因上下文溢出而中断
- 用户原始消息原文保留，不被摘要改写
- 压缩过程对 Agent Loop 透明，不改变工具系统和 Provider 接口

## 功能需求

### F1：Token 近似估算

维护两个会话级变量：

- `lastKnownTotalPromptTokens`：最近一次 `token.usage` 事件中的 `totalPromptTokens` 值（`AgentLoopTokenUsage.totalPromptTokens`，跨迭代累积值）
- `pendingChars`：自上次已知 token 计数后，`providerContext` 新增内容的字符数总和

估算公式：`estimated = lastKnownTotalPromptTokens + Math.ceil(pendingChars / 4)`

每次 `token.usage` 事件到达时：将 `lastKnownTotalPromptTokens` 更新为 `event.totalPromptTokens`，同时清零 `pendingChars`（此时估算误差已被 Provider 侧的真实用量重新锚定）。每次向 `providerContext` 追加消息时，将追加内容的字符数累加到 `pendingChars`。

模型窗口大小（`contextWindow`）通过 model 名前缀查表确定，**采用最长前缀优先匹配**（按下表顺序从上到下，第一条命中即返回）：

| 匹配顺序 | 前缀模式 | 窗口（tokens） |
|---------|----------|------------|
| 1 | `claude-*` | 200 000 |
| 2 | `gpt-4o*` | 128 000 |
| 3 | `gpt-4-turbo*` | 128 000 |
| 4 | `gpt-4*` | 8 000 |
| 5 | `gpt-3.5*` | 16 000 |
| 6 | （默认） | 128 000 |

**集成路径（`onTokenUsage`）：** `ChatSessionController.applyAgentLoopEvent` 中原先对 `token.usage` 返回 `undefined` 的 case，改为调用 `this.contextManager.onTokenUsage(event.totalPromptTokens)`，再返回 `undefined`（不产生 state 事件）。

**集成路径（`onMessagesAppended`）：** Controller 在以下两处向 `providerContext` 追加后调用：
1. **`completeTurn`** 中 `this.providerContext.push(toProviderMessage(userMessage), ...turnMessages, { role: 'assistant', content: finalText })` 之后，调用 `this.contextManager.onMessagesAppended(chars)`，其中 `chars` = 追加内容所有消息 `content` 字段字符数之和（用户消息 + turnMessages 各条的 `content` + finalText）。对 `ProviderAssistantToolCallMessage` 中的 `toolCalls` 数组不额外计算字符数，仅取其 `content` 字段（估算精度可接受，N1 允许）。
2. **`failTurn`** 中有条件 push 用户消息时，调用 `this.contextManager.onMessagesAppended(toProviderMessage(userMessage).content.length)`。
F3 步骤 4 重置估算时不通过 `onMessagesAppended`，而是在 `compress()` 内部直接全量重扫 `providerContext` 计算总字符数后赋值（同样只取各消息 `content` 字段字符数之和）。

### F2：工具结果卸载（第一层预防）

在每次用户 turn 的**第一次 API 请求前**（即 `submitUserText` 中 Agent Loop 启动之前），对 `providerContext` 中所有 `role: 'tool'` 消息执行卸载检查。当前 turn 新产生的工具结果会在**下一个用户 turn** 开始时被 F2 处理。目的是控制单条消息和单轮工具结果的体积，与全局水位无关。

**单条卸载：** 若某条工具结果的 `content` 字节数（`Buffer.byteLength(content, 'utf8')`）> 8 KB，将完整内容写入 `.agentcode/context-cache/<slug>.txt`，并将 `content` 替换为：

```
[内容已卸载至文件: {absolutePath}，共 {n} 字符]
--- 内容预览（前 200 字符）---
{preview}
---
如需完整内容，请用 read_file 重新读取原始路径。
```

文件名 `<slug>` 由 `toolCallId` 经过 slug 化处理生成（将非字母数字字符替换为 `-`，截断到 64 字符），确保文件名合法且基本可读。若同一 `slug` 文件已存在（重试场景），直接覆盖。

**turn 边界定义：** `providerContext` 是扁平数组，以 `role: 'user'` 消息作为 turn 起始标记。相邻两条 `role: 'user'` 消息之间（含第一条 user 消息，不含下一条 user 消息）的所有消息属于同一 turn。同一 turn 内相邻的 `role: 'tool'` 消息集合即为"同一轮工具结果块"。

**轮级合并卸载：** 对每个 turn，统计其所有工具结果消息的 `content` 字节合计。若合计仍 > 32 KB（单条卸载后重新统计），按 content 剩余字节数从大到小依次触发单条卸载，直到合计 ≤ 32 KB 或全部已卸载。

卸载文件在会话结束时不自动清理（供用户排查）；下次启动时文件如存在不影响新会话。

### F3：全局对话摘要（第二层兜底）

**触发条件：** F2 执行后，`estimated > contextWindow - safetyMargin`。
- 自动触发：`safetyMargin = 13 000`
- 手动触发（`/compress`）：`safetyMargin = 3 000`，仍执行水位检查；若 `estimated ≤ contextWindow - 3 000` 则跳过摘要并通知用户"上下文尚未到压缩阈值"。

**保留窗口：** 从 `providerContext` 尾部往前，以 `role: 'user'` 消息作为 turn 边界往回计数：

- 累计已扫描内容的估算 token（字符数 ÷ 4）≥ 10 000，或已回溯完整 turn 数 ≥ 5 个 turn，取**先满足的条件**停止。
- 保留窗口之前的消息为**待摘要区**。

若待摘要区消息数 < 2 条，跳过本次摘要（保留的上下文已经很少，不值得摘要）。

**摘要调用：** 通过当前 `provider.stream()` 接口发起独立请求，消费 stream 直至收到 `response.complete` 事件后聚合全部 `content.delta` 为完整文本（不经过 Agent Loop，不触发工具执行，不更新 `providerContext`）。request 内容：

- `system`（固定）：
  ```
  你是精确的会话历史摘要器。严格遵守以下规则：
  1. 禁止调用任何工具。
  2. 先在 <analysis> 标签内写出思考草稿（只用于推理，不出现在最终摘要中）。
  3. 在 <summary> 标签内按四个固定章节输出正式摘要。
  4. 不捏造未明确出现在历史中的文件内容或代码。
  ```
- `model`：当前会话的 `config.model`（与正常请求相同）
- `tools: []`（空数组）、`toolChoice: 'none'`
- `thinking: { enabled: false }`（关闭 thinking，避免干扰摘要提取）
- `messages`：待摘要区消息 + 尾部一条 `role: 'user'` 指令消息：
  ```
  以上是对话历史片段，请按如下格式生成摘要：
  <summary>
  ## 目标与背景
  ## 已完成操作
  ## 关键发现（含重要文件路径、结论）
  ## 未完成/待续
  </summary>
  ```

超时使用 `config.request.timeoutMs`（注入到 context manager 中，不硬编码）。

从响应中提取 `<summary>…</summary>` 之间的文本；草稿（`<analysis>`）直接丢弃。若 stream 以 `response.error` 事件结束、或完整响应文本中未找到 `<summary>` 标签，视为摘要失败。

**应用摘要：** 摘要调用成功后：

1. 从 `providerContext` 头部移除全部待摘要区消息（共 N 条）。
2. 在 `providerContext` 头部依次插入以下两条合成消息（顺序固定，最终结果为 `[user-summary, assistant-boundary, ...retained]`）：
   - 索引 0：`{ role: 'user', content: '[会话历史摘要]\n' + summaryText }`
   - 索引 1：F4 边界提示消息（`role: 'assistant'`，见 F4）
3. 重置 `lastKnownTotalPromptTokens = 0`，`pendingChars = providerContext 全部消息 content 字段字符数之和`（仅取 content，忽略 toolCalls）。
4. 同步更新 `protectedContextIndices`（见 N2）：设删除了 `N` 条消息、随后在头部插入了 2 条合成消息，则原集合中所有下标 `i` 按如下规则重映射：若 `i < N`（属于已删除范围）则从集合中移除；若 `i >= N` 则替换为 `i - N + 2`（位置前移 N、再因头部插入 2 条后延 2）。

### F4：边界提示消息

摘要成功后，在 F3 步骤 3 注入以下固定 `role: 'assistant'` 消息（合成，不经过 Provider）：

```
[上下文已压缩] 较早的会话历史已被摘要替代。
如需文件具体内容或代码细节，请使用 read_file / search_code 重新读取，
不要根据摘要推断代码内容。
```

### F5：熔断机制

维护 `consecutiveSummaryFailures` 计数器：

- 摘要调用抛出异常、stream 以 `response.error` 结束、或响应文本未找到 `<summary>`：`consecutiveSummaryFailures++`
- 摘要成功：`consecutiveSummaryFailures = 0`
- `consecutiveSummaryFailures >= 3`：停止**自动**触发摘要。手动 `/compress` 不受熔断影响，可随时触发；手动触发的失败不累加到 `consecutiveSummaryFailures`，不重置熔断计数。

熔断状态在会话生命周期内维持，不跨会话持久化。

### F6：手动触发

`ChatSessionController.parseCommand` 需同步更新返回类型，加入 `isCompress?: boolean` 字段：

```typescript
private parseCommand(text: string): { mode: AgentLoopMode; actualText: string; isCompress?: boolean }
```

识别 `/compress` 前缀时返回 `{ mode: this.currentMode, actualText: '', isCompress: true }`。注意：`/compress` 分支**不调用** `this.setLoopMode(mode)`，直接进入压缩逻辑。

`submitUserText` 入口在 **`userMessage` 创建和 `this.messages.push` 之前** 检测 `isCompress`——即在现有 `this.status === 'streaming'` 检查之后、`this.messages.push(userMessage)` 之前插入拦截点——确保 `/compress` 命令不会残留在 TUI 消息历史中：

1. 跳过用户消息创建、追加和 Agent Loop，直接调用 `contextManager.compress(this.providerContext, this.protectedContextIndices, true)`。
2. 摘要成功后，设置 `this.notice = '上下文已压缩'`，yield `createStateChangedEvent()`，然后 return（不继续走 Agent Loop）。
3. 摘要失败时，设置 `this.notice = '上下文压缩失败，请稍后重试'`，yield `createStateChangedEvent()`，然后 return。

### F7：触发时序

每次 `submitUserText` 开始（进入 Agent Loop 前）：

1. `/compress` 命令拦截：见 F6，拦截后直接 return，不走后续步骤。
2. 运行 F2（工具结果卸载）：`await contextManager.offloadToolResults(this.providerContext)`。
3. 若满足 F3 自动触发条件（`estimated > contextWindow - 13_000` 且 `consecutiveSummaryFailures < 3`），运行 F3：`await contextManager.compress(this.providerContext, this.protectedContextIndices)`。
4. 继续执行 Agent Loop。

Agent Loop 内部每轮迭代前不重复检查（本轮 token 增量在 turn 结束时才被锚定）。

## 非功能需求

- **N1：估算不依赖 tokenizer**：所有 token 计数均为近似值，不引入 tiktoken 或其他 tokenizer 依赖。估算偏差由 13K 安全余量吸收。
- **N2：用户消息不被改写**：`ChatSessionController` 在每次向 `providerContext` 追加 `role: 'user'` 的原始用户消息时，同步将该消息在 `providerContext` 中的下标记录到 `protectedContextIndices: Set<number>`。追加路径包括两处：`completeTurn` 中的 `toProviderMessage(userMessage)` 调用，以及 `failTurn` 中 `!this.contextMessages.some(...)` 成立时的追加调用。F2 的卸载仅针对 `role: 'tool'` 消息，不影响用户消息；F3 的摘要区移除操作前，必须确认待摘要区不包含 `protectedContextIndices` 中的消息——若包含，截断待摘要区使其不触及受保护消息（从最近一条受保护消息之前截止）。
- **N3：摘要调用超时**：摘要 LLM 调用使用 `config.request.timeoutMs`，通过 `AbortSignal` 实现（同现有工具执行的超时机制），超时视为摘要失败，触发熔断计数。
- **N4：可测试性**：压缩逻辑封装在 `src/context/ContextManager.ts` 中，最小公开接口如下（`ChatMessage` 指 `src/providers/types.ts` 中导出的 provider 层类型，即 `ProviderTextMessage | ProviderAssistantToolCallMessage | ProviderToolResultMessage`，不是 `src/session/types.ts` 中的会话层同名类型）：
  ```typescript
  interface ContextManagerOptions {
    contextWindow: number;     // 模型窗口大小
    offloadThresholdBytes: number;  // 单条卸载阈值，默认 8192
    turnOffloadThresholdBytes: number; // 轮级卸载阈值，默认 32768
    cacheDir: string;          // 卸载文件目录（绝对路径）
    timeoutMs: number;         // 摘要调用超时
  }

  // ChatMessage 来自 src/providers/types.ts（provider 层）
  class ContextManager {
    constructor(
      provider: ChatModelProvider,
      model: string,
      options: ContextManagerOptions,
    );
    onTokenUsage(totalPromptTokens: number): void;
    onMessagesAppended(chars: number): void;
    get estimated(): number;
    offloadToolResults(messages: ChatMessage[]): Promise<void>; // 就地修改
    compress(
      messages: ChatMessage[],
      protectedIndices: Set<number>,
      manual?: boolean,
    ): Promise<boolean>; // 就地修改，返回是否成功
    get circuitOpen(): boolean; // consecutiveSummaryFailures >= 3
  }
  ```
  所有阈值和窗口大小均通过 `ContextManagerOptions` 注入，测试时可注入小值验证触发边界。
- **N5：卸载目录自动创建**：写入 `.agentcode/context-cache/` 前若目录不存在则用 `fs.mkdir(dir, { recursive: true })` 自动创建，不报错。

## 不做的事

- 不实现精确 tokenizer（不引入 tiktoken 等依赖）
- 不做摘要策略的机器学习优化
- 不做卸载文件的自动清理（会话结束后文件留存）
- 不对摘要 LLM 调用结果做质量评分
- 不在 TUI 中展示当前 token 水位进度条（留给后续任务）
- 不支持自定义压缩阈值配置（通过 ContextManagerOptions 注入，暂不开放配置文件字段）

## 边界与异常

- 卸载写文件失败（磁盘满、权限问题）：捕获异常，记录 `console.warn`，跳过该条卸载，保持原始 content 不变，不中断流程
- 待摘要区消息数 < 2 条：跳过摘要，不报错，不计为失败，`compress()` 返回 `true`（视为成功，F6 侧显示"上下文已压缩"通知）
- 摘要响应文本不含 `<summary>` 标签：视为失败，`consecutiveSummaryFailures++`
- 熔断后用户发新消息导致 Provider 返回上下文过长错误：在 `applyAgentLoopEvent` 的 `loop.failed` case 中检测错误 message 包含 context/token/length 等关键词时，额外设置 `this.notice = '上下文过长，请使用 /compress 压缩后继续'`

## 验收标准

- **AC1（对应 F2）：** 在 `providerContext` 中注入一条 content 超过 8 KB 的工具结果消息，调用 `offloadToolResults` 后，该消息 content 缩减为预览格式，`.agentcode/context-cache/` 目录下存在对应文件且内容完整。
- **AC2（对应 F3）：** 将 `lastKnownTotalPromptTokens` 手动设置为 `contextWindow - 12 000`（estimated 超过自动触发阈值），调用 `compress` 后 `messages` 头部被替换为合成摘要消息，尾部近期消息原文保留。
- **AC3（对应 F3）：** 摘要调用时，`provider.stream` 收到的 request 中 `toolChoice === 'none'`，且 `tools` 为空数组或未传。
- **AC4（对应 F4）：** 摘要成功后，`providerContext` 中摘要消息之后紧跟一条 `role: 'assistant'` 内容含"上下文已压缩"的边界消息。
- **AC5（对应 F1）：** 单元测试中注入 `contextWindow = 20_000`，自动触发阈值 = 7 000（20_000 - 13_000）。设置 `lastKnownTotalPromptTokens = 6_500` 且 `pendingChars = 0`：`estimated = 6_500 < 7_000`，不触发摘要；再设置 `lastKnownTotalPromptTokens = 7_100`：`estimated = 7_100 > 7_000`，触发摘要。手动触发使用 `safetyMargin = 3_000`（阈值 17_000），estimated 须 > 17_000 才压缩；若 estimated ≤ 17_000 则 `compress()` 返回 false 并通知用户。
- **AC6（对应 F5）：** 模拟摘要连续失败 3 次后，`contextManager.circuitOpen === true`；此后自动压缩检查跳过；手动调用 `compress(messages, indices, true)` 仍可执行摘要（不受熔断影响）。
- **AC7（对应 F6）：** 用户输入 `/compress` 时，`submitUserText` 识别 `isCompress` 标志后调用 `contextManager.compress()`，完成后 `state.notice` 包含"上下文已压缩"，不触发 Agent Loop。
- **AC8（对应 N2）：** UI 层 `messages` 数组中的用户消息对应的 `providerContext` 下标被记录在 `protectedContextIndices` 中；摘要操作不移除这些位置的消息，AC 由单元测试验证截断逻辑。
- **AC9：** `npm run typecheck` 和 `npm test` 全部通过，现有工具和会话测试不退化。
