# 上下文压缩增强 Checklist

> 每一项必须通过测试输出或可观察行为验证，覆盖 GitHub Issue #54 和 #55。

## 绑定文档

- spec.md: 458a6e188c504c86297dcc1ec20ca332f4551663
- plan.md: 8ccdb29e1e6615d14d46af11c16be96c218b7a09
- tasks.md: 57a329dcac0e70c3746c57a79240d0375ea7ee7a

## 实现完整性

- [ ] src/context/compaction.ts 存在，导出档位、完整 turn、九段解析和恢复消息纯函数。
- [ ] ContextManager 导出 compact 结构化接口，不再导出旧 compress boolean 接口。
- [ ] ContextManagerOptions 支持 forceMargin、emergencyMargin 和可选 SkillContextSource。
- [ ] ChatSessionController 不再持有 protectedContextIndices。
- [ ] ChatSessionController 只识别 /compact，不把 /compress 作为命令别名。
- [ ] tests/unit/context/compaction.test.ts 存在并通过。
- [ ] task08 四份文档的绑定 hash 与当前内容一致。

## F1：Token 估算

- [ ] 初始 estimated 为 0。
- [ ] onMessagesAppended 接收 Provider 消息数组，按全部 content 字符数累计 pendingChars。
- [ ] onTokenUsage 更新已知 prompt token 并清零 pendingChars。
- [ ] F2 实际缩短消息后按最终数组重建估算。
- [ ] compact 成功或紧急兜底后按最终数组重建估算。
- [ ] compact 失败或跳过时不错误重置估算。

## F2：工具结果卸载

- [ ] content 大于 8 KB 的工具结果被写入 context-cache，消息替换为固定预览。
- [ ] content 小于等于 8 KB 时不卸载。
- [ ] 同一完整 turn 的工具结果总量大于 32 KB 时优先卸载较大结果。
- [ ] 缓存目录不存在时递归创建。
- [ ] 写文件失败时保留原始 content，不抛出到主流程。
- [ ] 卸载前已经通过 onMessagesAppended 记录结构化文件路径。

## F3：三档 compact

- [ ] contextWindow=20000、estimated=7000 时 auto 返回 below_threshold。
- [ ] estimated=7001 时选择 normal。
- [ ] estimated=15000 时仍为 normal，15001 时选择 force。
- [ ] estimated=18000 时仍为 force，18001 时选择 emergency。
- [ ] forceMargin 和 emergencyMargin 缺省值分别为 5000 和 2000。
- [ ] 非法 margin 顺序在构造时抛 RangeError。
- [ ] Controller 不重复判断 estimated、contextWindow 或 circuitOpen。
- [ ] compact 返回 compacted、emergency_fallback、skipped 或 failed 的结构化结果。
- [ ] normal/force 失败时 providerContext 逐项不变。

## F4：完整 turn 和工具配对

- [ ] 保留窗口只在真实 user turn 起点切分。
- [ ] token 目标先满足时仍保留触发该目标的整个 turn。
- [ ] 5 turn 目标先满足时保留最近 5 个完整 turn。
- [ ] 一条 assistant 内多个 tool calls 及其全部 tool results 整组保留或整组摘要。
- [ ] 孤立 tool result 或未知 toolCallId 不进入部分改写。
- [ ] 合成摘要、边界、文件和 Skill 恢复消息不计为真实 turn。
- [ ] 没有较早完整 turn 可摘要时返回 skipped/no_history。

## F5：九段式两阶段摘要

- [ ] System Prompt 明确要求先生成 analysis 草稿，再生成 summary 正文。
- [ ] 最终只持久化 summary，不包含 analysis 草稿。
- [ ] 正文严格包含 1 到 9 共九个固定章节，顺序正确且各出现一次。
- [ ] 第 3 节只允许保留历史中真实出现的文件、代码段和结论。
- [ ] 第 6 节模型输出固定用户消息占位符。
- [ ] 第 8 节被明确要求为最详细章节。
- [ ] tools 为空、toolChoice 为 none、thinking disabled。
- [ ] stream 未收到 response.complete 时不接受摘要。
- [ ] 缺标题、错序、重复/缺失占位符或多个 summary 块均视为失败。

## 用户消息原文

- [ ] Controller 从完整 contextMessages 提取所有已提交 user 正文。
- [ ] 当前尚未执行的 user turn 不会提前进入本次自动摘要。
- [ ] /compact 命令本身不进入用户消息列表。
- [ ] 第 6 节由程序替换占位符，不采用模型转述。
- [ ] 用户原文不 trim、不转义、不去重、不改写。
- [ ] 包含 Markdown 标题、XML 文本、空白和重复内容时仍逐字符保留。
- [ ] prompt-too-long 丢弃旧摘要 turn 后，全部用户消息仍完整。
- [ ] 紧急机械兜底仍恢复全部用户原文。

## F6：Prompt Too Long 重试

- [ ] 首次使用完整摘要 turn 调用。
- [ ] 第 2、3、4 次调用分别从当前剩余 turn 丢弃最旧 10%，最少 1 个。
- [ ] 第 5 次调用从当前剩余 turn 丢弃最旧 20%，最少 1 个。
- [ ] 总 Provider 调用次数最多 5 次。
- [ ] 任一次成功后立即停止重试。
- [ ] 每次裁剪都以完整 turn 为单位。
- [ ] 每次请求使用独立 timeout signal。
- [ ] context window、context length、maximum token、token limit、prompt/input too long 可触发降级。
- [ ] 认证 token、限流、网络、timeout、协议错误和非法 summary 不触发降级。
- [ ] 候选 turn 被删空时不发送仅含摘要指令的请求。
- [ ] 一组内部重试最终只改变一次熔断计数。

## F7：最近文件路径恢复

- [ ] read_file 成功结果记录 path，必要时从配对调用参数回退。
- [ ] search_code 记录成功 matches 中的 path。
- [ ] glob_files 记录成功 matches。
- [ ] 失败或非结构化结果不通过文本猜测路径。
- [ ] 恢复顺序严格为 read_file、search_code、glob_files。
- [ ] 同一来源内最近访问优先。
- [ ] 跨来源路径规范化去重。
- [ ] 最多恢复 5 个路径。
- [ ] 恢复块不包含文件正文，并提示需要时重新 read_file。

## F7：Skill 恢复接口

- [ ] 默认 SkillContextSource 返回空数组，不生成 Skill 恢复块。
- [ ] ContextManager 不实现 /skill、磁盘加载或 Skill 使用跟踪。
- [ ] 可注入来源按 lastUsedOrder 从新到旧恢复 renderedContent。
- [ ] 总预算为 25000 近似 tokens。
- [ ] 最后一个超预算定义按剩余容量截断，之后停止。
- [ ] Skill 块位于文件路径块之后、近期真实 turn 之前。

## F8：紧急机械兜底

- [ ] 只有 emergency 档位摘要最终失败时执行机械兜底。
- [ ] 紧急前缀包含全部用户消息原文。
- [ ] 紧急边界明确说明摘要失败和较早 assistant/tool 信息已删除。
- [ ] 紧急文案不声称旧历史已经被摘要。
- [ ] 文件路径和 Skill 恢复仍按正常顺序注入。
- [ ] 尾部保留最近 5 个完整真实 turn。
- [ ] 最近 turn 中不存在孤立 tool result。
- [ ] 机械兜底后 token 估算按最终数组重置。

## F9：熔断

- [ ] auto normal 最终失败一次只增加 1。
- [ ] 连续 3 次失败后 circuitOpen 为 true。
- [ ] auto normal 在 circuit open 时跳过 Provider。
- [ ] auto force 和 emergency 绕过 circuit。
- [ ] manual 任意档位绕过 circuit。
- [ ] manual 失败不增加计数。
- [ ] 任意摘要成功清零计数。
- [ ] auto emergency 机械兜底成功仍记录一次摘要失败，不清零。

## F10：/compact

- [ ] /compact 在低水位也先执行 F2，再调用 compact/manual。
- [ ] /compact 不进入 UI transcript。
- [ ] /compact 与相同档位的自动路径生成相同上下文结构。
- [ ] /compress 作为普通用户文本进入 AgentLoop。
- [ ] no_history 提示“没有可压缩的历史”。
- [ ] compacted 提示“上下文已压缩”。
- [ ] emergency_fallback 提示“上下文已紧急压缩，摘要失败后已使用机械兜底”。
- [ ] failed 提示“上下文压缩失败，请稍后重试”。
- [ ] Provider 上下文过长 notice 建议使用 /compact。

## 重复 compact

- [ ] 第二次 compact 不把旧合成前缀计为真实 turn。
- [ ] 第二次摘要输入保留上一代摘要语义，但移除上一代第 6 节原文块。
- [ ] 旧文件和 Skill 恢复块不重复进入摘要请求。
- [ ] 连续 compact 后只有一个摘要块、一个文件块和一个 Skill 块。
- [ ] 连续 compact 后第 6 节仍包含全部用户原文。
- [ ] 没有新摘要 turn 时返回 no_history，不对旧摘要反复摘要。

## 静态检查与回归

- [ ] npm run typecheck 通过，0 errors。
- [ ] npm run lint 通过，0 errors/warnings。
- [ ] npm test -- tests/unit/context/ 全部通过。
- [ ] npm test -- tests/unit/session/ChatSessionController.test.ts 通过。
- [ ] npm test 全量通过。
- [ ] npm run build 通过。
- [ ] git diff --check 通过。
- [ ] npm run e2e:tmux 在 psmux/tmux 可用时通过；不可用时记录环境阻塞。
