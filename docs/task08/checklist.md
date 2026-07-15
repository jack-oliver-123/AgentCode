# 上下文压缩增强 Checklist

> 每一项必须通过测试输出或可观察行为验证，覆盖 GitHub Issue #54 和 #55。

## 绑定文档

- spec.md: 458a6e188c504c86297dcc1ec20ca332f4551663
- plan.md: 8ccdb29e1e6615d14d46af11c16be96c218b7a09
- tasks.md: 57a329dcac0e70c3746c57a79240d0375ea7ee7a

## 实现完整性

- [x] src/context/compaction.ts 存在，导出档位、完整 turn、九段解析和恢复消息纯函数。
- [x] ContextManager 导出 compact 结构化接口，不再导出旧 compress boolean 接口。
- [x] ContextManagerOptions 支持 forceMargin、emergencyMargin 和可选 SkillContextSource。
- [x] ChatSessionController 不再持有 protectedContextIndices。
- [x] ChatSessionController 只识别 /compact，不把 /compress 作为命令别名。
- [x] tests/unit/context/compaction.test.ts 存在并通过。
- [x] checklist 中 spec.md、plan.md、tasks.md 的绑定 hash 与当前内容一致。

## F1：Token 估算

- [x] 初始 estimated 为 0。
- [x] onMessagesAppended 接收 Provider 消息数组，按全部 content 字符数累计 pendingChars。
- [x] onTokenUsage 更新已知 prompt token 并清零 pendingChars。
- [x] F2 实际缩短消息后按最终数组重建估算。
- [x] compact 成功或紧急兜底后按最终数组重建估算。
- [x] compact 失败或跳过时不错误重置估算。

## F2：工具结果卸载

- [x] content 大于 8 KB 的工具结果被写入 context-cache，消息替换为固定预览。
- [x] content 小于等于 8 KB 时不卸载。
- [x] 同一完整 turn 的工具结果总量大于 32 KB 时优先卸载较大结果。
- [x] 缓存目录不存在时递归创建。
- [x] 写文件失败时保留原始 content，不抛出到主流程。
- [x] 卸载前已经通过 onMessagesAppended 记录结构化文件路径。

## F3：三档 compact

- [x] contextWindow=20000、estimated=7000 时 auto 返回 below_threshold。
- [x] estimated=7001 时选择 normal。
- [x] estimated=15000 时仍为 normal，15001 时选择 force。
- [x] estimated=18000 时仍为 force，18001 时选择 emergency。
- [x] forceMargin 和 emergencyMargin 缺省值分别为 5000 和 2000。
- [x] 非法 margin 顺序在构造时抛 RangeError。
- [x] Controller 不重复判断 estimated、contextWindow 或 circuitOpen。
- [x] compact 返回 compacted、emergency_fallback、skipped 或 failed 的结构化结果。
- [x] normal/force 失败时 providerContext 逐项不变。

## F4：完整 turn 和工具配对

- [x] 保留窗口只在真实 user turn 起点切分。
- [x] token 目标先满足时仍保留触发该目标的整个 turn。
- [x] 5 turn 目标先满足时保留最近 5 个完整 turn。
- [x] 一条 assistant 内多个 tool calls 及其全部 tool results 整组保留或整组摘要。
- [x] 孤立 tool result 或未知 toolCallId 不进入部分改写。
- [x] 合成摘要、边界、文件和 Skill 恢复消息不计为真实 turn。
- [x] 没有较早完整 turn 可摘要时返回 skipped/no_history。

## F5：九段式两阶段摘要

- [x] System Prompt 明确要求先生成 analysis 草稿，再生成 summary 正文。
- [x] 最终只持久化 summary，不包含 analysis 草稿。
- [x] 正文严格包含 1 到 9 共九个固定章节，顺序正确且各出现一次。
- [x] 第 3 节只允许保留历史中真实出现的文件、代码段和结论。
- [x] 第 6 节模型输出固定用户消息占位符。
- [x] 第 8 节被明确要求为最详细章节。
- [x] tools 为空、toolChoice 为 none、thinking disabled。
- [x] stream 未收到 response.complete 时不接受摘要。
- [x] 缺标题、错序、重复/缺失占位符或多个 summary 块均视为失败。

## 用户消息原文

- [x] Controller 从完整 contextMessages 提取所有已提交 user 正文。
- [x] 当前尚未执行的 user turn 不会提前进入本次自动摘要。
- [x] /compact 命令本身不进入用户消息列表。
- [x] 第 6 节由程序替换占位符，不采用模型转述。
- [x] 用户原文不 trim、不转义、不去重、不改写。
- [x] 包含 Markdown 标题、XML 文本、空白和重复内容时仍逐字符保留。
- [x] prompt-too-long 丢弃旧摘要 turn 后，全部用户消息仍完整。
- [x] 紧急机械兜底仍恢复全部用户原文。

## F6：Prompt Too Long 重试

- [x] 首次使用完整摘要 turn 调用。
- [x] 第 2、3、4 次调用分别从当前剩余 turn 丢弃最旧 10%，最少 1 个。
- [x] 第 5 次调用从当前剩余 turn 丢弃最旧 20%，最少 1 个。
- [x] 总 Provider 调用次数最多 5 次。
- [x] 任一次成功后立即停止重试。
- [x] 每次裁剪都以完整 turn 为单位。
- [x] 每次请求使用独立 timeout signal。
- [x] context window、context length、maximum token、token limit、prompt/input too long 可触发降级。
- [x] 认证 token、限流、网络、timeout、协议错误和非法 summary 不触发降级。
- [x] 候选 turn 被删空时不发送仅含摘要指令的请求。
- [x] 一组内部重试最终只改变一次熔断计数。

## F7：最近文件路径恢复

- [x] read_file 成功结果记录 path，必要时从配对调用参数回退。
- [x] search_code 记录成功 matches 中的 path。
- [x] glob_files 记录成功 matches。
- [x] 失败或非结构化结果不通过文本猜测路径。
- [x] 恢复顺序严格为 read_file、search_code、glob_files。
- [x] 同一来源内最近访问优先。
- [x] 跨来源路径规范化去重。
- [x] 最多恢复 5 个路径。
- [x] 恢复块不包含文件正文，并提示需要时重新 read_file。

## F7：Skill 恢复接口

- [x] 默认 SkillContextSource 返回空数组，不生成 Skill 恢复块。
- [x] ContextManager 不实现 /skill、磁盘加载或 Skill 使用跟踪。
- [x] 可注入来源按 lastUsedOrder 从新到旧恢复 renderedContent。
- [x] 总预算为 25000 近似 tokens。
- [x] 最后一个超预算定义按剩余容量截断，之后停止。
- [x] Skill 块位于文件路径块之后、近期真实 turn 之前。

## F8：紧急机械兜底

- [x] 只有 emergency 档位摘要最终失败时执行机械兜底。
- [x] 紧急前缀包含全部用户消息原文。
- [x] 紧急边界明确说明摘要失败和较早 assistant/tool 信息已删除。
- [x] 紧急文案不声称旧历史已经被摘要。
- [x] 文件路径和 Skill 恢复仍按正常顺序注入。
- [x] 尾部保留最近 5 个完整真实 turn。
- [x] 最近 turn 中不存在孤立 tool result。
- [x] 机械兜底后 token 估算按最终数组重置。

## F9：熔断

- [x] auto normal 最终失败一次只增加 1。
- [x] 连续 3 次失败后 circuitOpen 为 true。
- [x] auto normal 在 circuit open 时跳过 Provider。
- [x] auto force 和 emergency 绕过 circuit。
- [x] manual 任意档位绕过 circuit。
- [x] manual 失败不增加计数。
- [x] 任意摘要成功清零计数。
- [x] auto emergency 机械兜底成功仍记录一次摘要失败，不清零。

## F10：/compact

- [x] /compact 在低水位也先执行 F2，再调用 compact/manual。
- [x] /compact 不进入 UI transcript。
- [x] /compact 与相同档位的自动路径生成相同上下文结构。
- [x] /compress 作为普通用户文本进入 AgentLoop。
- [x] no_history 提示“没有可压缩的历史”。
- [x] compacted 提示“上下文已压缩”。
- [x] emergency_fallback 提示“上下文已紧急压缩，摘要失败后已使用机械兜底”。
- [x] failed 提示“上下文压缩失败，请稍后重试”。
- [x] Provider 上下文过长 notice 建议使用 /compact。
- [x] /compact 执行期间先发布 streaming 忙碌状态，并拒绝并发普通提交。
- [x] /compact 的 F2/compact 异常被捕获并映射为失败 notice；完成或迭代器提前关闭时恢复命令前的 status/lastError。

## 重复 compact

- [x] 第二次 compact 不把旧合成前缀计为真实 turn。
- [x] 第二次摘要输入保留上一代摘要语义，但移除上一代第 6 节原文块。
- [x] 旧文件和 Skill 恢复块不重复进入摘要请求。
- [x] 连续 compact 后只有一个摘要块、一个文件块和一个 Skill 块。
- [x] 连续 compact 后第 6 节仍包含全部用户原文。
- [x] 没有新摘要 turn 时返回 no_history，不对旧摘要反复摘要。

## 静态检查与回归

- [x] npm run typecheck 通过，0 errors。
- [x] npm run lint 通过，0 errors/warnings。
- [x] npm test -- tests/unit/context/ 全部通过。
- [x] npm test -- tests/unit/session/ChatSessionController.test.ts 通过。
- [ ] npm test 全量通过。
- [x] npm run build 通过。
- [x] git diff --check 通过。
- [ ] npm run e2e:tmux 在 psmux/tmux 可用时通过；不可用时记录环境阻塞。

## 验证记录（2026-07-15）

- `git hash-object docs/task08/spec.md docs/task08/plan.md docs/task08/tasks.md`：通过；依次为 `458a6e188c504c86297dcc1ec20ca332f4551663`、`8ccdb29e1e6615d14d46af11c16be96c218b7a09`、`57a329dcac0e70c3746c57a79240d0375ea7ee7a`，与顶部绑定一致。
- `npm run lint`：通过；Biome 检查 143 个文件，0 errors/warnings。
- `npm run typecheck`：通过；exit 0，0 TypeScript errors。
- `npm test -- tests/unit/context/ tests/unit/session/ChatSessionController.test.ts`：通过；4 个测试文件、135 个测试全部通过。
- `npm test`：未通过；50 个测试文件中 46 通过、4 失败，673 个测试中 656 通过、15 失败、2 跳过。失败均位于未被本功能改动的 `tests/unit/tools/`：`edit-file` 1 项、`read-file` 2 项、`write-file` 4 项和 `run-command` 8 项。
- 失败文件隔离复跑：`edit-file` 8/8 通过；`read-file` 最终 10/11（120 ms executor 限制下实际 130 ms 超时）；`write-file` 最终 6/7，且两次失败用例不同；`run-command` 6/14，多数命令在当前 Windows bash 环境中达到 5 秒测试超时。功能分支未修改 `src/tools/` 或 `tests/unit/tools/`，这些结果归类为既有短超时/Windows bash 环境问题，而非本功能回归。
- `npm run build`：通过；exit 0，`dist/cli/main.js` 存在。
- `npm run e2e:tmux`：未通过；其内置 build 通过，随后 bash 报错 `tests/e2e/tmux/agentcode-smoke.sh: line 2: set: pipefail\r: invalid option name`，归类为 Windows CRLF/bash 环境阻塞。
- `git diff --check`：通过；无空白错误。
