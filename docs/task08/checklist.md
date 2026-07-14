# 上下文管理 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 绑定文档

- spec.md: `4df5c77bb6cf5974ad02b6e096043275481ba9ad`
- plan.md: `3f91b3021a40e1293c68d6ef5d7482c0cba54220`
- tasks.md: `1e8b08327c2697ddb22a078896e7b644c942e071`

## AC5 偏差说明

spec AC5 原文将手动水位检查（estimated ≤ contextWindow - 3000）描述为 `compress()` 的行为；本任务以 plan.md 为准，将该检查上移至 `ChatSessionController` 层，`compress()` 不负责该检查。对应验收通过 T5 的"compress 未被调用"用例（Controller 层代理验收），行为语义等价。

---

## 实现完整性

- [ ] `src/context/contextWindow.ts` 存在，导出 `lookupContextWindow` 函数（验证：`npm run typecheck` 通过）
- [ ] `src/context/ContextManager.ts` 存在，导出 `ContextManager` 类（验证：typecheck 通过）
- [ ] `src/context/index.ts` 存在，重导出 `ContextManager` 和 `lookupContextWindow`（验证：typecheck 通过）
- [ ] `src/session/ChatSessionController.ts` 新增 `contextManager` 和 `protectedContextIndices` 两个私有字段（验证：typecheck 通过）
- [ ] `tests/unit/context/contextWindow.test.ts` 存在（验证：`npm test -- tests/unit/context/contextWindow.test.ts` 通过）
- [ ] `tests/unit/context/contextManager.test.ts` 存在（验证：`npm test -- tests/unit/context/contextManager.test.ts` 通过）
- [ ] `tests/unit/session/ChatSessionController.test.ts` 已更新（验证：`npm test -- tests/unit/session/` 通过）

---

## F1：token 估算（AC5 部分）

- [ ] 初始 `contextManager.estimated === 0`（验证：`contextManager.test.ts`）
- [ ] `onMessagesAppended(400)` 后 `estimated === 100`（验证：`contextManager.test.ts`）
- [ ] `onTokenUsage(5000)` 后 `estimated === 5000`，pendingChars 清零（验证：`contextManager.test.ts`）
- [ ] `onTokenUsage(5000)` 后再 `onMessagesAppended(800)` → `estimated === 5200`（验证：`contextManager.test.ts`）
- [ ] AC5：contextWindow=20000，estimated=6500（< 7000）不触发自动摘要；estimated=7100（> 7000）触发（验证：`contextManager.test.ts`）

---

## F2：工具结果卸载（AC1）

- [ ] AC1：content > 8KB 的工具结果消息调用 `offloadToolResults` 后，content 缩减为预览格式，以 `[内容已卸载至文件:` 起头（验证：`contextManager.test.ts`）
- [ ] AC1：对应 `.agentcode/context-cache/` 目录下存在 .txt 文件，文件内容为原始 content 完整字节（验证：`contextManager.test.ts`）
- [ ] content < 8KB 的消息不触发卸载，content 保持原值，缓存目录无新增文件（验证：`contextManager.test.ts`）
- [ ] 同一 turn 内两条工具结果（22KB + 15KB），轮级合计 37KB > 32KB；卸载后先卸载 22KB 那条，合计降至 15KB（验证：`contextManager.test.ts`）
- [ ] 两个不同 turn（role:'user' 分隔）各自写入独立文件，slug 来自各自 toolCallId（验证：`contextManager.test.ts`）
- [ ] 写文件失败时 content 保持原始值，不抛出异常，其他消息继续处理（验证：`contextManager.test.ts`）
- [ ] N5：cacheDir 不存在时首次调用 `offloadToolResults`，目录被自动创建（fs.mkdir recursive 被调用）（验证：`contextManager.test.ts`）

---

## F3：LLM 摘要（AC2、AC3）

- [ ] AC2：estimated 超过自动触发阈值（7100 > 7000）后调用 `compress`，messages 头部被替换为 `[user-summary, assistant-boundary]`，尾部保留区原文不变（验证：`contextManager.test.ts`）
- [ ] AC3：摘要调用时，`provider.stream` 收到的 request 中 `toolChoice === 'none'`，`tools` 为空数组（验证：`contextManager.test.ts`）
- [ ] 摘要成功后 `estimated` 等于 messages 全部 content 字符数之和除以 4（lastKnownTotalPromptTokens 被重置为 0，pendingChars 全量重扫赋值）（验证：`contextManager.test.ts`）
- [ ] mock stream 不返回 `<summary>` 标签，`compress` 返回 `false`（验证：`contextManager.test.ts`）
- [ ] N3：mock provider.stream() 触发 AbortError（超时），compress 返回 false，consecutiveSummaryFailures 递增（验证：`contextManager.test.ts`）
- [ ] 待摘要区 < 2 条，`compress` 返回 `true` 且不调用 provider.stream()（验证：`contextManager.test.ts`）

---

## F4：边界提示消息（AC4）

- [ ] AC4：摘要成功后，messages[1].role === 'assistant'，messages[1].content 包含字符串 `"[上下文已压缩]"`（验证：`contextManager.test.ts`）

---

## F5：熔断机制（AC6）

- [ ] AC6：连续失败 3 次后 `circuitOpen === true`（验证：`contextManager.test.ts`）
- [ ] AC6：circuitOpen=true 时自动调用 compress 不触发 provider.stream()，返回 true（验证：`contextManager.test.ts`）
- [ ] AC6：手动调用 `compress(messages, set, true)` 失败不增加 consecutiveSummaryFailures，circuitOpen 保持 false（验证：`contextManager.test.ts`）

---

## N2：protectedContextIndices（AC8）

- [ ] AC8：protectedIndices 含 N-1（受保护消息在待摘要区），截断待摘要区 N 值使其不包含受保护消息，摘要成功返回 true 不报错（验证：`contextManager.test.ts`）
- [ ] AC8：摘要成功后 protectedIndices 正确重映射（原 i>=N → i-N+2；原 i<N 的保护项被移除）（验证：`contextManager.test.ts`）

---

## F6：/compress 命令（AC7）

- [ ] AC7：用户输入 `/compress`，compress 成功后 `state.notice` 含"上下文已压缩"，messages 数组中不出现 `/compress` 文本，contextManager.compress 以 manual=true 调用（验证：`ChatSessionController.test.ts`）
- [ ] `/compress` 且 compress() 返回 false（LLM 失败）：`state.notice` 含"上下文压缩失败，请稍后重试"（验证：`ChatSessionController.test.ts`）
- [ ] `/compress` 且 estimated ≤ contextWindow - 3000：contextManager.compress 未被调用，`state.notice` 含"上下文尚未到压缩阈值"（AC5 Controller 层代理验收，见文件顶部偏差说明）（验证：`ChatSessionController.test.ts`）

---

## F7：submitUserText 正常路径时序

- [ ] 正常 submitUserText：`contextManager.offloadToolResults` 在 `runAgentLoop` 前被调用，以 providerContext 为参数（验证：`ChatSessionController.test.ts`）
- [ ] 正常 submitUserText 且 estimated 超过自动阈值且 circuitOpen=false：`contextManager.compress` 以 manual=false（或省略）在 runAgentLoop 前被调用（验证：`ChatSessionController.test.ts`）

---

## F1 集成：token 使用与消息追踪

- [ ] applyAgentLoopEvent 处理 token.usage 事件后，调用 `contextManager.onTokenUsage(totalPromptTokens)`，参数值与事件一致（验证：`ChatSessionController.test.ts`）
- [ ] completeTurn 路径：protectedContextIndices 包含该轮 user 消息在 providerContext 中的下标，contextManager.onMessagesAppended 参数等于 user 消息 content 字符数 + 该轮每条 turnMessage.content 字符数之和 + finalText.length（验证：`ChatSessionController.test.ts`）
- [ ] failTurn 路径（push user 消息的分支）：protectedContextIndices 同样包含该 user 消息下标，contextManager.onMessagesAppended 被调用（N2 双路覆盖）（验证：`ChatSessionController.test.ts`）

---

## 边界与异常

- [ ] loop.failed 事件且错误信息含 "context length" 关键词：`state.notice` 含"上下文过长，请使用 /compress 压缩后继续"（验证：`ChatSessionController.test.ts`）
- [ ] loop.failed 事件且错误信息含 "token" 关键词（如 "maximum token limit exceeded"）：`state.notice` 同样含"上下文过长，请使用 /compress 压缩后继续"（验证：`ChatSessionController.test.ts`）

---

## 编译与回归（AC9）

- [ ] AC9：`npm run typecheck` 通过（0 errors）
- [ ] AC9：`npm test -- tests/unit/context/` 全部通过
- [ ] AC9：`npm test -- tests/unit/session/` 全部通过（现有工具和会话测试不退化）
- [ ] AC9：`npm test` 全量通过
- [ ] （可选）`npm run e2e:tmux` 端到端验证（需 psmux/tmux；不可用时记录为环境阻塞）
