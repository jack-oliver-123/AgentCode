# Agent Loop Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 审查来源

- spec.md 验收标准：AC1-AC11 已全覆盖
- plan.md 风险与回滚：已覆盖（Provider 多 tool call、abort 传播、Controller 重构、E2E mock）
- 当前分支 vs main diff：无实现 diff 可审，已审查空 diff + 已批准文档 + 当前代码上下文
- 子代理发现处理：2 个子代理分别从安全/错误处理和正确性/回归角度审查，有效发现已转化为下方可验证条目

## 实现完整性

- [ ] `runAgentLoop` async generator 可被调用并 yield 事件流（验证：AgentLoop.test.ts 通过）
- [ ] `checkStopCondition` 纯函数覆盖全部 5 种停止条件（验证：stopCondition.test.ts 通过）
- [ ] `createBatches` 按 risk 正确分组（验证：ToolScheduler.test.ts 通过）
- [ ] `executeBatches` 并发/串行执行正确（验证：ToolScheduler.test.ts 通过）
- [ ] `submit_plan` 工具 validate 和 execute 正常工作（验证：单元测试通过）
- [ ] `ToolRegistry.filterByRisk()` 返回只含指定 risk 工具的新 registry（验证：单元测试通过）
- [ ] OpenAI Provider emit 所有 tool call 事件（验证：provider 单元测试通过）
- [ ] Anthropic Provider emit 所有 tool call 事件（验证：provider 单元测试通过）
- [ ] ChatSessionController 委托 AgentLoop 并通过 applyAgentLoopEvent 映射（验证：Controller 单元测试通过）
- [ ] `/plan` 命令只注入 read 类工具 + submit_plan（验证：单元测试通过）
- [ ] `/do` 命令注入全部工具并将 storedPlan 作为上下文（验证：单元测试通过）

## 核心行为验证（对应 AC1-AC11）

- [ ] AC1: 多步工具调用自主完成——用户发送需要 2+ 步工具的消息，Agent 自主循环完成全部步骤（验证：AgentLoop.test.ts 多步场景）
- [ ] AC2: 迭代上限终止——设 maxIterations=3，provider 永远返回工具调用，循环在第 3 轮后终止并报告 reason='max_iterations'（验证：单元测试）
- [ ] AC3: 用户取消——abort signal 触发后循环干净退出，无悬挂 Promise（验证：单元测试 + setTimeout 验证无 unhandled rejection）
- [ ] AC4: 连续未知工具——连续 N 次调用不存在工具后循环终止，reason='unknown_tool_limit'（验证：单元测试）
- [ ] AC5: Provider 错误——stream 中 response.error 事件导致循环终止并 yield loop.failed（验证：单元测试）
- [ ] AC6: 流式显示——每轮 text.delta 实时 yield，TUI 通过 state.changed 驱动渲染（验证：单元测试事件序列 + E2E pane capture）
- [ ] AC7: 事件流完整性——事件流包含 iteration.start、text.delta、tool_call.start、tool_call.result、token.usage、loop.completed（验证：单元测试断言事件类型序列）
- [ ] AC8: 多工具并发——一次返回 2 read + 1 write 时，read 并发执行，write 串行执行，结果全部回写（验证：ToolScheduler + AgentLoop 单元测试）
- [ ] AC9: Plan Mode——`/plan` 触发 read-only 循环，模型通过 submit_plan 输出步骤列表，存储在 storedPlan（验证：单元测试）
- [ ] AC10: Do Mode——`/do` 注入全部工具和 storedPlan 上下文，模型自主执行（验证：单元测试）
- [ ] AC11: 上下文正确性——循环中每次 provider.stream() 包含本 turn 全部已完成的工具调用和结果（验证：断言 provider 收到的 messages 数组）

## 回归检查

- [ ] 并发提交拒绝：status=streaming 时再次 submitUserText 返回错误（验证：Controller 单元测试）
- [ ] 失败 turn 状态正确：loop.failed 后 status=idle，draft 清空，userMessage 保留在 contextMessages（验证：单元测试）
- [ ] Assistant 消息不含 thinking 文本：completeTurn 只保留 visibleText（验证：单元测试）
- [ ] Provider 错误时部分文本不 commit：loop.failed 后 messages 不含 partial text（验证：单元测试）
- [ ] contextMessages 跨 turn 正确累积：第二次 submitUserText 的 provider 请求包含第一次完整历史（验证：多 turn 单元测试）
- [ ] 对外接口不变：submitUserText 返回 AsyncIterable<ChatSessionEvent>，事件类型为 state.changed（验证：TypeScript 编译 + TUI 无改动验证）
- [ ] getState() 返回深拷贝（验证：修改返回对象不影响内部状态）
- [ ] completeTurn 后 status 回到 idle（验证：loop.completed → 最终 state.status === 'idle'）

## 安全与错误处理

- [ ] Redaction 链在循环中连续有效：createToolContext 工厂每次传入完整 secrets 列表，工具结果经过 redaction 后才追加到 messages（验证：单元测试 + E2E sentinel 检测）
- [ ] loop.failed 事件的 error.message 不含 raw secret（验证：单元测试构造含 apiKey 的 error）
- [ ] thinking.delta 内容不追加到发给 provider 的 messages 数组（验证：单元测试）
- [ ] abort signal 触发后不启动新迭代和新 provider 调用（验证：AgentLoop 单元测试）
- [ ] 单工具 timeout 不影响同 batch 其他并发工具（验证：ToolScheduler 单元测试）
- [ ] Provider stream 无 response.complete 时 yield loop.failed（验证：AgentLoop 单元测试）
- [ ] Promise.allSettled rejected 项正确映射为 error result（验证：ToolScheduler 单元测试）
- [ ] 非法 JSON argumentsText 不触发 unknownTool 计数递增（验证：AgentLoop 单元测试）
- [ ] 未知工具名在 TUI activity 中显示为泛化 'tool'（验证：Controller 单元测试）
- [ ] show_thinking=false 时 thinking 文本不出现在 TUI 输出中（验证：E2E pane capture）

## 类型安全

- [ ] ToolJsonSchema 支持 array 类型（submit_plan 需要）（验证：typecheck 通过 + submit_plan schema 定义编译成功）
- [ ] 多工具场景下 assistant message 的 toolCalls 为数组、每个 tool result 为独立 ProviderToolResultMessage（验证：单元测试断言消息结构）
- [ ] ToolRegistry mock/helper 同步更新 filterByRisk 方法（验证：全部测试编译通过）
- [ ] AgentLoop 内部统一使用 Provider 级消息类型，不与 Session 级 ChatMessage 混淆（验证：typecheck 通过）

## 边界情况

- [ ] /do 时 storedPlan 为空（未先 /plan）：正常运行 full mode，不 crash（验证：Controller 单元测试）
- [ ] Plan Mode 中模型不调用 submit_plan 而返回纯文本：触发 natural 停止，storedPlan 不更新（验证：AgentLoop 单元测试）
- [ ] Plan Mode 中模型在 submit_plan 同批次返回其他工具调用：只处理 submit_plan，忽略其余（验证：AgentLoop 单元测试）
- [ ] signal 在 AgentLoop 启动前已 aborted：第一轮检查后 yield loop.completed(cancelled)（验证：单元测试）
- [ ] ToolScheduler 收到空 calls 数组：返回空结果不 crash（验证：单元测试）
- [ ] 混合调用中 1 已知 + 1 未知工具：consecutiveUnknownTools 重置为 0（验证：AgentLoop 单元测试）

## 编译与测试

- [ ] `npm run typecheck` 零错误
- [ ] `npm test` 全部通过
- [ ] `npm run build` 构建成功

## 端到端场景

- [ ] 场景 1：多步自主循环——mock provider 返回 read_file → 工具结果回写 → write_file → 工具结果回写 → 最终文本。TUI 显示多个工具 activity 和最终回答。API key 不泄露到 pane/stdout/stderr。（验证：`npm run e2e:tmux`）
- [ ] 场景 2：迭代上限——配置 maxIterations=3，mock provider 永远返回工具调用。TUI 显示友好的"已达迭代上限"信息而非 crash。（验证：E2E 或手动观察）
- [ ] 场景 3：现有单工具场景回归——原有 E2E smoke test 的单工具闭环仍然通过。（验证：`npm run e2e:tmux` 原有场景不改动）
