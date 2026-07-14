# 上下文管理 Tasks

## 绑定输入

- spec.md: `4df5c77bb6cf5974ad02b6e096043275481ba9ad`
- plan.md: `3f91b3021a40e1293c68d6ef5d7482c0cba54220`

## 文件清单

| 操作 | 路径 | 任务 |
|------|------|------|
| 新建 | `src/context/contextWindow.ts` | T1 |
| 新建 | `src/context/ContextManager.ts` | T2、T3、T4 |
| 新建 | `src/context/index.ts` | T4 |
| 修改 | `src/session/ChatSessionController.ts` | T5 |
| 新建 | `tests/unit/context/contextWindow.test.ts` | T1 |
| 新建 | `tests/unit/context/contextManager.test.ts` | T2、T3、T4 |
| 修改 | `tests/unit/session/ChatSessionController.test.ts` | T5 |

## T1: lookupContextWindow 查表函数

**目标：** 实现 model 名前缀查表，返回 contextWindow 大小；最长前缀优先匹配。

**文件：** `src/context/contextWindow.ts`、`tests/unit/context/contextWindow.test.ts`

**依赖：** 无

**测试先行：**

1. 新建 `tests/unit/context/contextWindow.test.ts`，添加以下先行用例（此时无实现，应失败）：
   - `lookupContextWindow('claude-3-opus-20240229')` → `200000`
   - `lookupContextWindow('gpt-4o-2024-11-20')` → `128000`
   - `lookupContextWindow('gpt-4-turbo-preview')` → `128000`
   - `lookupContextWindow('gpt-4-0613')` → `8000`（gpt-4* 但非 gpt-4o* 和 gpt-4-turbo*）
   - `lookupContextWindow('gpt-3.5-turbo')` → `16000`
   - `lookupContextWindow('unknown-model-xyz')` → `128000`（默认）
2. 运行 `npm test -- tests/unit/context/contextWindow.test.ts`，确认全部失败。
3. 实现 `lookupContextWindow`（按 spec F1 的匹配顺序）。
4. 重跑，预期全部通过。

**回归验证：** `npm test -- tests/unit/context/`

**任务后审查：** 低风险，1 个只读 reviewer；评分、完整性校验和 hash 绑定遵循 review rubric。

---

## T2: ContextManager 骨架 + F1 token 估算

**目标：** 创建 `ContextManager` 类，实现 `onTokenUsage`、`onMessagesAppended`、`estimated` 三个接口；初始状态正确（两个变量均为 0）。

**文件：** `src/context/ContextManager.ts`、`tests/unit/context/contextManager.test.ts`

**依赖：** T1

**测试先行：**

1. 在 `tests/unit/context/contextManager.test.ts` 添加 F1 先行用例（此时无实现）：
   - 初始 `estimated === 0`
   - `onMessagesAppended(400)` 后 `estimated === 100`（400/4）
   - `onTokenUsage(5000)` 后 `estimated === 5000`，pendingChars 清零
   - `onMessagesAppended(800)` 后 `estimated === 5200`（5000 + 200）
2. 运行，确认失败。
3. 实现骨架类 + F1 逻辑（不含 offloadToolResults / compress）。
4. 重跑，预期通过。

**回归验证：** `npm test -- tests/unit/context/`

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T3: offloadToolResults（F2 卸载）

**目标：** 实现 `offloadToolResults(messages)`：单条 > 8KB 存盘替换为 spec F2 规定的预览模板；轮级 > 32KB 挑大依次卸载；turn 边界为 `role:'user'` 消息；写文件失败时 console.warn 跳过不中断。

**文件：** `src/context/ContextManager.ts`（F2 实现）、`tests/unit/context/contextManager.test.ts`

**依赖：** T2

**测试先行：**

1. 添加 F2 先行用例：
   - 注入 1 条 content 为 9000 字节的 `role:'tool'` 消息，调用 `offloadToolResults` 后：
     - content 必须符合 spec F2 固定模板结构，以 `[内容已卸载至文件:` 起头，包含 `--- 内容预览（前 200 字符）---` 段落和绝对文件路径
     - cacheDir 下存在对应 `.txt` 文件，文件内容为原始 content 完整字节
   - 注入 1 条 content 为 5000 字节的消息，调用后 content 保持原值，cacheDir 下无新增文件
   - 注入同一 turn 内 2 条工具结果（分别 22KB 和 15KB），合计 37KB > 32KB；轮级卸载后先卸载 22KB 那条，合计降至 15KB ≤ 32KB
   - 两个不同 turn（role:'user' 分隔）各有一条 9KB 工具结果，卸载后各自写入独立文件，文件名中 slug 来自各自 toolCallId
   - 写文件失败（mock fs.writeFile 抛出）时，该条 content 保持原始值，不抛出异常，其他消息继续处理
   - cacheDir 不存在时（mock fs.mkdir 可观察），首次调用 `offloadToolResults` 写入 >8KB 工具结果后，验证 `fs.mkdir` 以 `{ recursive: true }` 被调用（N5 目录自动创建）
2. 运行，确认失败。
3. 实现 F2 逻辑。
4. 重跑，预期通过。

**回归验证：** `npm test -- tests/unit/context/`

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T4: compress（F3 摘要 + F4 边界消息 + F5 熔断）

**目标：** 实现 `compress(messages, protectedIndices, manual?)`：保留窗口计算（10K token 或 5 turn）、LLM 摘要调用（provider.stream()）、状态重置、protectedContextIndices 重映射、熔断计数；导出 `src/context/index.ts`。

**水位检查责任边界：** 自动路径（manual 省略或 false）的水位检查（estimated ≤ contextWindow - 13000）在 compress() 内部处理，返回 true（非失败，跳过）。手动路径（manual=true）的水位检查（estimated ≤ contextWindow - 3000）在 ChatSessionController 层处理，compress() 不负责该检查，即在 manual=true 且 estimated > contextWindow - 3000 时才会被调用。**注：spec AC5 将该检查写为 compress() 的行为，本任务以 plan.md 为准，将检查上移至 Controller 层，T5 通过"compress 未被调用"验证该分支。**

**文件：** `src/context/ContextManager.ts`（F3/F4/F5 实现）、`src/context/index.ts`、`tests/unit/context/contextManager.test.ts`

**依赖：** T3

**测试先行（以 `contextWindow=20000` 为锚定值）：**

1. 添加以下先行用例（mock provider.stream()）：
   - estimated=6500（≤ 20000-13000=7000），`compress(messages, set)` 返回 `true` 且不调用 provider.stream()
   - estimated=7100（> 7000），触发摘要调用；mock stream 返回含 `<summary>测试摘要内容</summary>` 的响应：
     - messages 头部被替换为 `[user-summary(index 0), assistant-boundary(index 1)]`；尾部保留区原文不变
     - `messages[1].role === 'assistant'`，`messages[1].content` 包含字符串 `"[上下文已压缩]"`（AC4）
     - 捕获 provider.stream() 收到的 request，验证 `request.toolChoice === 'none'` 且 `request.tools` 长度为 0（AC3）
     - 摘要成功后 `estimated` 等于 messages 全部 content 字符数之和除以 4（`lastKnownTotalPromptTokens` 被重置为 0，`pendingChars` 全量重扫赋值）
   - mock provider.stream() 在 AbortSignal abort 时抛出 AbortError（模拟 timeoutMs 超时）：`compress` 返回 `false`，`consecutiveSummaryFailures` 递增（N3 超时视为失败）
   - mock stream 不返回 `<summary>` 标签，`compress` 返回 `false`，`circuitOpen` 仍为 false（失败 1 次）
   - 连续失败 3 次后 `circuitOpen === true`；再次以 manual=false 调用 `compress` 不触发 stream，返回 true
   - `compress(messages, set, true)`（手动）：失败不增加 `consecutiveSummaryFailures`，`circuitOpen` 保持 false
   - protectedIndices 含 `N-1`（受保护消息在待摘要区），截断待摘要区 N 值使其不包含受保护消息，摘要成功返回 true 不报错
   - 摘要成功后 `protectedIndices` 正确重映射（原 i>=N → i-N+2；原 i<N 的保护项被移除）
   - 待摘要区 < 2 条，`compress` 返回 `true` 不调用 stream
2. 运行，确认失败。
3. 实现 F3/F4/F5 逻辑 + 创建 `src/context/index.ts` 导出 `ContextManager`（class）和 `lookupContextWindow`（function）。`SUMMARY_SYSTEM_PROMPT` 和 `SUMMARY_INSTRUCTION` 抽取为模块级常量，内容见 spec F3"摘要调用"节的两个固定字符串代码块（system 字段和 messages 末尾 user 指令消息）。
4. 重跑，预期通过。

**回归验证：** `npm test -- tests/unit/context/`

**任务后审查：** 高风险（跨模块 + LLM 调用 + 状态变更），3 个只读 reviewer。

---

## T5: ChatSessionController 集成

**目标：** 在 `ChatSessionController` 中集成 `ContextManager`：新增两个私有字段；扩展 `parseCommand` 返回类型加 `isCompress?`；在 `submitUserText` 加 `/compress` 拦截点（messages.push 前，不调 setLoopMode）；在 `submitUserText` 正常路径于 AgentLoop 前调用 `offloadToolResults` 和自动 `compress`；在 `applyAgentLoopEvent` 的 `token.usage` case 调用 `onTokenUsage`；在 `applyAgentLoopEvent` 的 `loop.failed` case 检测 context/token/length 关键词并设置 notice；在 `completeTurn` / `failTurn` 调用 `onMessagesAppended` 并追加 `protectedContextIndices`；`ChatSessionControllerOptions` 加 `contextManager?` 测试注入口。

**文件：** `src/session/ChatSessionController.ts`、`tests/unit/session/`（现有测试回归）

**依赖：** T4

**测试先行：**

1. 在现有 Controller 测试目录确认现有测试（如 `ChatSessionController.test.ts`）先通过：`npm test -- tests/unit/session/`（基线）。
2. 添加集成先行用例（注入 mock contextManager）：
   - `token.usage` 事件：处理后调用 `contextManager.onTokenUsage(totalPromptTokens)`，参数值与事件一致
   - `completeTurn` 路径：`protectedContextIndices` 包含该轮 user 消息在 providerContext 中的下标，且调用 `contextManager.onMessagesAppended` 参数等于 user 消息 content 字符数 + 该轮每条 turnMessage.content 字符数之和 + finalText.length（对应 spec F1 集成路径中的三项之和）
   - `failTurn` 路径（push user 消息的分支）：`protectedContextIndices` 同样包含该 user 消息下标，`contextManager.onMessagesAppended` 被调用（spec N2 双路覆盖）
   - 正常 `submitUserText`：`contextManager.offloadToolResults` 在 `runAgentLoop` 前被调用，且以 providerContext 为参数
   - 正常 `submitUserText` 且 estimated 超过自动阈值（mock `contextManager.estimated` 返回超阈值、`circuitOpen` 为 false）：`contextManager.compress` 以 `manual` 省略（或 false）被调用，且在 `runAgentLoop` 之前（F7 自动压缩路径）
   - `/compress` 成功：`state.notice` 含"上下文已压缩"，`messages` 数组中不出现 `/compress` 文本，`contextManager.compress` 以 `manual=true` 调用
   - `/compress` 且 `compress()` 返回 false（LLM 失败）：`state.notice` 含"上下文压缩失败，请稍后重试"
   - `/compress` 且 estimated ≤ contextWindow - 3000：`contextManager.compress` 未被调用，`state.notice` 含"上下文尚未到压缩阈值"（此用例作为 AC5 的 Controller 层代理验收：spec AC5 原文描述为 compress() 返回 false，本任务以 plan.md 为准将检查上移至 Controller 层，行为语义等价）
   - `loop.failed` 事件且错误信息含 "context length" 关键词：`state.notice` 含"上下文过长，请使用 /compress 压缩后继续"
   - `loop.failed` 事件且错误信息含 "token" 关键词（如 "maximum token limit exceeded"）：`state.notice` 同样含"上下文过长，请使用 /compress 压缩后继续"
3. 运行，确认先行用例失败（基线测试应保持通过）。
4. 实现 Controller 集成改动。
5. 重跑全部，预期全部通过：`npm test -- tests/unit/session/` 且 `npm run typecheck`。

**回归验证：** `npm run typecheck && npm test`

**任务后审查：** 高风险（修改 Controller 核心流程），3 个只读 reviewer。

---

## 执行顺序

```text
T1 → T2 → T3 → T4 → T5
```
