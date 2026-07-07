# Agent Loop Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/agent/types.ts` | Agent Loop 全部类型定义 |
| 新建 | `src/agent/stopCondition.ts` | 停止条件纯函数 |
| 新建 | `src/agent/ToolScheduler.ts` | 多工具并发/串行调度 |
| 新建 | `src/agent/AgentLoop.ts` | 主循环 async generator |
| 新建 | `src/agent/index.ts` | barrel export |
| 新建 | `src/tools/builtins/submitPlan.ts` | submit_plan 工具定义 |
| 修改 | `src/tools/registry.ts` | 新增 filterByRisk() 方法 |
| 修改 | `src/providers/openai/OpenAIProvider.ts` | emit 所有 tool call |
| 修改 | `src/providers/anthropic/AnthropicProvider.ts` | emit 所有 tool call |
| 修改 | `src/session/types.ts` | 扩展 session 状态 |
| 修改 | `src/session/ChatSessionController.ts` | 重构为 Agent Loop 适配器 |
| 修改 | `src/tui/useChatController.ts` | 识别 /plan、/do 命令 |
| 修改 | `src/tui/components/TranscriptPane.tsx` | 显示迭代进度 |
| 新建 | `tests/unit/agent/stopCondition.test.ts` | 停止条件测试 |
| 新建 | `tests/unit/agent/ToolScheduler.test.ts` | 调度策略测试 |
| 新建 | `tests/unit/agent/AgentLoop.test.ts` | 主循环全场景测试 |
| 修改 | `tests/helpers/FakeProvider.ts` | 支持多轮动态序列 |
| 修改 | `tests/unit/session/ChatSessionController.test.ts` | 适配重构后的 Controller |

## T1: Agent Loop 类型定义

**文件：** `src/agent/types.ts`
**依赖：** 无
**步骤：**
1. 创建 `src/agent/` 目录
2. 定义 `AgentLoopConfig` 接口（maxIterations、maxConsecutiveUnknownTools）
3. 定义 `AgentLoopInput` 接口（contextMessages、userMessage、mode、plan、signal）
4. 定义 `AgentLoopDeps` 接口（provider、toolRegistry、createToolContext、config）
5. 定义 `PlanStep` 接口（title、description）
6. 定义完整 `AgentLoopEvent` discriminated union（9 个 variant，每个有完整 payload）
7. 定义 `AgentLoopStopReason` 类型
8. 定义 `StopConditionContext` 和 `StopDecision` 类型
9. 定义 `ToolBatch` 接口
10. 导出全部类型

**验证：** `npm run typecheck` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T2: 停止条件纯函数

**文件：** `src/agent/stopCondition.ts`、`tests/unit/agent/stopCondition.test.ts`
**依赖：** T1
**步骤：**
1. 实现 `checkStopCondition(ctx: StopConditionContext): StopDecision`
2. 按优先级判断：cancelled > provider_error > natural > unknown_tool_limit > max_iterations > { stop: false }
3. 编写测试覆盖：
   - 每种停止原因的基本触发
   - 边界值：iteration 恰好等于 maxIterations
   - cancelled 优先级高于其他条件
   - 空文本 + 无工具调用 = natural
   - consecutiveUnknownTools 等于阈值时触发
   - 所有条件都不满足时返回 { stop: false }

**验证：** `npm test -- tests/unit/agent/stopCondition.test.ts` 全部通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T3: ToolRegistry 扩展 filterByRisk

**文件：** `src/tools/registry.ts`
**依赖：** 无
**步骤：**
1. 在 `ToolRegistry` 接口中新增 `filterByRisk(allowedRisks: ToolRisk[]): ToolRegistry`
2. 在 `StaticToolRegistry` 中实现：过滤工具列表，返回新的 `StaticToolRegistry` 实例
3. 确保 `getProviderDeclarations()` 和 `get()` 在新实例上仅返回过滤后的工具
4. 补充单元测试验证过滤行为

**验证：** `npm run typecheck` 通过 + 相关测试通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T4: Provider 多工具调用支持（独立 commit）

**文件：** `src/providers/openai/OpenAIProvider.ts`、`src/providers/anthropic/AnthropicProvider.ts`
**依赖：** 无
**步骤：**
1. 修改 OpenAI provider：当 `finish_reason === 'tool_calls'` 时，遍历 `toolCallAccumulator` 中的所有条目，为每个 tool call 都 yield 一个 `tool.call` 事件（当前只 yield index 0）
2. 修改 Anthropic provider：移除 `emittedToolCall = false` 限制，为每个 `content_block_stop`（类型为 tool_use）都 yield 一个 `tool.call` 事件
3. 更新现有 provider 单元测试验证多 tool call emit
4. **此修改作为独立 commit 提交**

**验证：** `npm run typecheck` + provider 相关单元测试通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T5: ToolScheduler 实现

**文件：** `src/agent/ToolScheduler.ts`、`tests/unit/agent/ToolScheduler.test.ts`
**依赖：** T1、T3
**步骤：**
1. 实现 `createBatches(calls, registry): ToolBatch[]`
   - read 类工具归入一个 concurrent batch
   - write/execute 类工具各占一个 sequential batch
   - 未知工具不进 batch，直接生成 error 结果
   - 返回顺序：concurrent batch 在前，sequential batch 按原始顺序
2. 实现 `executeBatches(batches, registry, context): Promise<results[]>`
   - concurrent batch 用 Promise.allSettled
   - sequential batch 逐个 await
   - abort 后后续 batch 不再开始
   - 结果按原始调用顺序排列
3. 编写测试覆盖：
   - 纯 read 工具 → 一个 concurrent batch
   - 纯 write/execute → 多个 sequential batch
   - 混合 → read 先并发，write 后串行
   - 未知工具 → 直接产出 error
   - 单个工具超时不影响其余（allSettled）
   - abort 传播：中途 abort 后后续 batch 不执行

**验证：** `npm test -- tests/unit/agent/ToolScheduler.test.ts` 全部通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T6: submit_plan 工具定义

**文件：** `src/tools/builtins/submitPlan.ts`、`src/tools/registry.ts`（注册）
**依赖：** T3
**步骤：**
1. 创建 `submitPlan.ts`，定义 ToolDefinition：
   - name: 'submit_plan'
   - description: 描述其用途（Plan Mode 下输出结构化计划）
   - inputSchema: steps 数组（每步有 title + description）
   - risk: 'read'
   - validate: 校验 steps 数组格式
   - execute: 直接返回 parsed steps 数据
2. 将 submit_plan 注册到 StaticToolRegistry（但默认不加入工具列表——只在 Plan Mode 时通过 filterByRisk + 手动注入方式提供）
3. 编写单元测试验证 validate 和 execute 行为

**验证：** `npm run typecheck` + 测试通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T7: FakeProvider 增强

**文件：** `tests/helpers/FakeProvider.ts`
**依赖：** T4
**步骤：**
1. 扩展 FakeProvider 支持动态多轮序列：
   - 支持传入 `ProviderEvent[][]`（每个子数组对应一次 stream 调用）
   - 支持 onRequest callback 模式：根据收到的 messages 动态决定返回事件
2. 支持在一次 stream 调用中 emit 多个 `tool.call` 事件
3. 新增辅助函数 `collectEvents(generator)` 收集 async generator 全部事件
4. 确保现有使用 FakeProvider 的测试不被破坏

**验证：** `npm test` 全部通过（现有测试不回归）

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T8: AgentLoop 主循环实现

**文件：** `src/agent/AgentLoop.ts`、`tests/unit/agent/AgentLoop.test.ts`
**依赖：** T1、T2、T4、T5、T6、T7
**步骤：**
1. 实现 `runAgentLoop(input, deps): AsyncGenerator<AgentLoopEvent>`：
   - 根据 mode 过滤 registry（plan 模式注入 read + submit_plan）
   - 构建初始消息（含 plan 注入为 system context）
   - while 循环：yield iteration.start → stream provider → 双路收集（yield delta + 累积）→ 收集 tool calls → stopCondition 检查 → ToolScheduler 执行 → yield 结果 → 追加消息
   - finally 块：无独立资源需释放
2. submit_plan 特殊处理：识别后 yield plan.submitted，结束循环
3. consecutiveUnknownTools 计数逻辑：全是未知则+1，有已知则重置为 0
4. 编写测试覆盖：
   - 正常完成：2 轮工具 + 最终文本
   - 迭代上限：设 maxIterations=3，provider 永远返回工具
   - 用户取消：abort signal 触发
   - 连续未知工具：达到阈值终止
   - Provider 错误：response.error 事件
   - 多工具并发：一次返回 2 read + 1 write，验证执行顺序
   - Plan Mode：只注入 read 工具 + submit_plan
   - 事件流完整性：验证所有事件类型按正确顺序 yield
   - 上下文正确性：验证每次 provider.stream 包含完整历史

**验证：** `npm test -- tests/unit/agent/AgentLoop.test.ts` 全部通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T9: Agent Loop barrel export

**文件：** `src/agent/index.ts`
**依赖：** T8
**步骤：**
1. 从 `types.ts` 导出所有公共类型
2. 从 `AgentLoop.ts` 导出 `runAgentLoop`
3. 从 `stopCondition.ts` 导出 `checkStopCondition`
4. 从 `ToolScheduler.ts` 导出 `createBatches`、`executeBatches`

**验证：** `npm run typecheck` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T10: ChatSessionController 重构

**文件：** `src/session/ChatSessionController.ts`、`src/session/types.ts`、`tests/unit/session/ChatSessionController.test.ts`
**依赖：** T8、T9
**步骤：**
1. 扩展 `src/session/types.ts`：
   - `ChatSessionDraftActivity` 新增 iteration 信息
   - `ChatSessionState` 新增 `loopProgress?: { iteration, maxIterations }`、`storedPlan?: PlanStep[]`
2. 重构 `ChatSessionController.submitUserText()`：
   - 移除原有的 provider 调用和工具执行逻辑
   - 创建 AgentLoopInput（根据命令前缀决定 mode）
   - 创建 AgentLoopDeps（provider、registry、createToolContext 工厂、config）
   - for await 遍历 runAgentLoop()
   - 每个事件通过 `applyAgentLoopEvent()` 转为 draft 更新 → yield state.changed
3. 实现 `applyAgentLoopEvent()` 映射：
   - text.delta → draft.visibleText += delta
   - thinking.delta → draft.thinkingText += delta
   - tool_call.start → draft.activity = { type: 'tool', toolName }
   - iteration.start → 重置 draft 文本，activity = thinking
   - loop.completed → completeTurn()
   - loop.failed → failTurn()
   - plan.submitted → this.storedPlan = steps
4. 新增 `/plan` 和 `/do` 命令识别（文本前缀检查）
5. 新增 `currentMode` 和 `storedPlan` 字段
6. 重写 Controller 单元测试适配新行为

**验证：** `npm run typecheck` + `npm test -- tests/unit/session/` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T11: TUI 适配

**文件：** `src/tui/useChatController.ts`、`src/tui/components/TranscriptPane.tsx`
**依赖：** T10
**步骤：**
1. `useChatController.ts`：
   - 识别用户输入的 `/plan` 和 `/do` 前缀，传递给 controller
   - 无需改变 for-await 消费模式（Controller 对外接口不变）
2. `TranscriptPane.tsx`：
   - 从 draft/state 中读取 loopProgress 显示迭代进度（如 "Step 2/50"）
   - 显示存储的 plan steps（如果有）
   - 确保多轮工具 activity 正确显示

**验证：** `npm run typecheck` + `npm run build` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T12: E2E 测试扩展

**文件：** E2E smoke test 相关文件
**依赖：** T11
**步骤：**
1. 改造 mock SSE server 支持多轮：同一 user turn 的多次 provider 请求按 messages 数组长度匹配不同响应
2. 新增多步循环场景：mock 返回 read_file tool call → tool result → write_file tool call → tool result → 最终文本
3. 验证 TUI 显示多个工具 activity 和最终回答
4. 验证 API key 不泄露（现有 sentinel 检测复用）
5. 确保现有单工具 smoke 场景仍然通过

**验证：** `npm run e2e:tmux` 通过（如果 psmux/tmux 可用）

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T13: 全量集成验证

**文件：** 无新文件
**依赖：** T12
**步骤：**
1. 运行 `npm run typecheck` 确保零错误
2. 运行 `npm test` 确保全部测试通过
3. 运行 `npm run build` 确保构建成功
4. 运行 `npm run e2e:tmux` 验证端到端行为
5. 手动验证（如果可能）：`npm run dev` 启动 CLI，发送多步任务确认自主循环工作

**验证：** 全部通过，无回归

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## 执行顺序

```
T1 (类型) ─────┐
               ├── T2 (stopCondition)
               ├── T5 (ToolScheduler) ←── T3 (filterByRisk)
               │
T4 (Provider) ─┤── T7 (FakeProvider)
               │
T3 ────────────┤── T6 (submit_plan)
               │
               └── T8 (AgentLoop 主循环) ←── T2, T5, T6, T7
                        │
                        T9 (barrel export)
                        │
                        T10 (Controller 重构)
                        │
                        T11 (TUI 适配)
                        │
                        T12 (E2E 测试)
                        │
                        T13 (全量验证)
```

可并行任务：T2、T3、T4 无互相依赖可同时进行；T5 和 T6 在 T3 完成后可并行。
