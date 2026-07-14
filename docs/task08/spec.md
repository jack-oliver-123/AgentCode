# 上下文管理 Spec

## 背景

AgentCode 的 `ChatSessionController` 在 `providerContext` 中累积跨 turn 的 Provider 消息。工具结果通常是主要 token 消耗来源；长会话会逐渐逼近模型上下文窗口并触发 Provider 错误。

PR #53 已实现 F1 token 估算、F2 工具结果卸载和基础 F3 摘要，但存在以下缺口：

- `protectedContextIndices` 会保护每一条用户消息，首条通常位于索引 0，导致真实会话的摘要区被截为空。
- 保留边界可能落在 assistant tool call 与 tool result 中间。
- 压缩后没有恢复最近文件路径和已使用 Skill 定义。
- 摘要请求超长时没有降级重试。
- 自动压缩只有一个水位，并且受熔断后无法在临界水位继续自救。
- 手动命令使用 `/compress` 且受水位限制，不符合随时主动 compact 的使用方式。

本次规格覆盖 GitHub Issue #54 和 #55，并以 `/compact` 作为唯一手动命令。

## 目标

- 在有限 token 预算内支持长会话持续运行。
- 普通、强制、紧急三档自动压缩共用一条实现管线。
- `/compact` 可在任意水位手动触发同一压缩算法。
- 所有真实用户消息由程序逐字恢复，不依赖 LLM 转述。
- 最近完整 turn、工具调用配对、最近文件路径和 Skill 定义在压缩后可恢复。
- 摘要请求本身过长时可按完整 turn 降级重试。
- 摘要完全失败且已进入紧急水位时，仍能机械缩减上下文。
- UI 会话历史保持完整；只修改发送给 Provider 的 `providerContext`。

## 术语

- **UI 会话历史**：`ChatSessionController` 的 `messages` / `contextMessages`，不因压缩而删除或改写。
- **Provider 上下文**：发送给模型的 `providerContext`，允许被摘要和机械缩减。
- **真实 turn**：从一条真实 `role: 'user'` 消息开始，到下一条真实 user 消息之前的完整消息组。
- **合成前缀**：压缩生成的摘要、边界、文件路径和 Skill 恢复消息，不计入真实 turn 数。
- **摘要区**：本次将被摘要替换的旧合成摘要和较早完整 turn。
- **保留区**：本次压缩后仍逐字保留的近期完整 turn。

## 功能需求

### F1：Token 近似估算

维护两个会话级变量：

- `lastKnownTotalPromptTokens`：最近一次 `token.usage` 事件中的 `totalPromptTokens`。
- `pendingChars`：自上次已知 token 计数后新增 Provider 消息的 `content` 字符数总和。

估算公式：

```text
estimated = lastKnownTotalPromptTokens + Math.ceil(pendingChars / 4)
```

集成规则：

1. `onTokenUsage(totalPromptTokens)` 更新已知 token 基准并清零 `pendingChars`。
2. `onMessagesAppended(messages)` 接收本轮实际追加的 Provider 消息，同时累计字符数并记录读取类工具产生的文件路径。
3. F2 卸载或 F3 compact 改写已有消息后，全量重扫最终 `providerContext`，将 `lastKnownTotalPromptTokens` 重置为 0，并以总字符数重建 `pendingChars`。

模型窗口继续通过 model 名前缀查表确定，采用最长前缀优先匹配：

| 匹配顺序 | 前缀 | 窗口（tokens） |
|---|---|---:|
| 1 | `claude-*` | 200000 |
| 2 | `gpt-4o*` | 128000 |
| 3 | `gpt-4-turbo*` | 128000 |
| 4 | `gpt-4*` | 8000 |
| 5 | `gpt-3.5*` | 16000 |
| 6 | 默认 | 128000 |

### F2：工具结果卸载与文件路径记录

每次 compact 或正常 Agent Loop 启动前，对 `providerContext` 的 `role: 'tool'` 消息执行卸载检查。

#### F2.1 单条卸载

若工具结果 `content` 的 UTF-8 字节数大于 8 KB，将完整内容写入 `.agentcode/context-cache/<slug>.txt`，并把消息内容替换为包含缓存绝对路径和前 200 字符预览的固定模板。写入失败时 `console.warn`，保留原始 content，不中断流程。

#### F2.2 turn 级卸载

同一真实 turn 的工具结果合计大于 32 KB 时，按剩余字节数从大到小继续卸载，直到合计不超过 32 KB或已无可卸载结果。

#### F2.3 最近文件路径账本

`onMessagesAppended(messages)` 在工具结果尚未被 F2 改写时解析结构化结果，并维护会话级轻量路径账本：

- `read_file`：记录成功结果中的 `path`，必要时回退到对应 tool call 参数中的 `path`。
- `search_code`：记录成功结果 `matches[].path`。
- `glob_files`：记录成功结果 `matches[]`。
- 只使用 `toolCallId` 与 assistant `toolCalls[].id` 的明确配对；失败或无法解析的结果静默忽略，不用宽泛正则猜测路径。
- 账本只保存路径、来源和最近访问顺序，不保存文件正文。

### F3：统一 compact 管线

`ContextManager.compact()` 是自动和手动压缩的唯一入口。Controller 不重复实现水位或熔断判断。

#### F3.1 触发来源

- `auto`：每个正常用户 turn 在 F2 后调用；未达到普通水位时由 ContextManager 返回跳过。
- `manual`：用户输入 `/compact` 时调用；不做水位门禁，任何时候都尝试同一压缩算法。

手动和自动的区别仅是触发来源与准入规则；相同压缩档位必须生成相同的上下文结构。

#### F3.2 自动压缩档位

默认水位按严格大于判断，优先级为 emergency > force > normal：

| 档位 | 触发条件 | 熔断是否阻止 | 摘要最终失败 |
|---|---|---|---|
| normal | `estimated > contextWindow - 13000` | 是 | 返回失败，原上下文不变 |
| force | `estimated > contextWindow - forceMargin`，默认 `forceMargin=5000` | 否 | 返回失败，原上下文不变 |
| emergency | `estimated > contextWindow - emergencyMargin`，默认 `emergencyMargin=2000` | 否 | 执行机械兜底 |

`forceMargin` 与 `emergencyMargin` 仅属于 `ContextManagerOptions`，本次不新增 YAML 配置字段。构造时必须满足 `13000 > forceMargin > emergencyMargin >= 0`。

手动触发在低水位按 normal 算法执行；若当前水位已达到 force 或 emergency，则使用相同档位及对应失败策略。

#### F3.3 结构化结果

compact 不再用一个 boolean 同时表示成功、失败和跳过，返回结构化结果：

```typescript
type CompactionTrigger = 'auto' | 'manual';
type CompactionLevel = 'normal' | 'force' | 'emergency';

type CompactionResult =
  | { outcome: 'compacted'; level: CompactionLevel; attempts: number }
  | { outcome: 'emergency_fallback'; level: 'emergency'; attempts: number }
  | {
      outcome: 'skipped';
      reason: 'below_threshold' | 'circuit_open' | 'no_history';
      level?: CompactionLevel;
      attempts: 0;
    }
  | { outcome: 'failed'; level: CompactionLevel; attempts: number };
```

摘要或紧急上下文必须先在临时数组中完整构建；只有 `compacted` 或 `emergency_fallback` 才一次性替换原数组。失败时 `providerContext` 不得发生部分改写。

### F4：完整 turn 与保留窗口

所有保留、摘要重试和紧急截断都以完整真实 turn 为最小单位。

#### F4.1 turn 划分

- 一条真实 `role: 'user'` 消息开始一个 turn。
- 该 user 之后的 assistant 文本、assistant tool call、全部匹配的 tool result 和最终 assistant 回复均属于同一 turn。
- 合成摘要、边界、文件路径和 Skill 恢复消息不计入真实 turn。
- assistant `toolCalls[].id` 与 tool message 的 `toolCallId` 必须完整配对；边界不得落在配对中间。

#### F4.2 正常保留窗口

从真实 turn 尾部向前累计：

- 累计 content 近似 token 达到 10000；或
- 已累计最近 5 个完整 turn。

满足任一条件后，在该完整 turn 的起点停止。较早完整 turn 进入摘要区，保留区逐字不变。

如果没有任何较早完整 turn 可摘要，返回 `skipped/no_history`。手动 `/compact` 此时提示“没有可压缩的历史”。

### F5：九段式两阶段摘要

摘要在一次 Provider 响应中分为两个生成阶段，而不是额外调用两次 Provider：

1. `<analysis>`：整理草稿、时间顺序、冲突、错误、当前工作和下一步。
2. `<summary>`：输出正式九段摘要。

固定章节及顺序：

```markdown
## 1. 主要请求和意图
用户到底想做什么

## 2. 关键技术概念
讨论过的重要技术点

## 3. 文件和代码段
涉及哪些文件；只保留历史中确实出现过的关键代码片段

## 4. 错误和修复
遇到了什么错误，如何解决

## 5. 问题解决过程
解决问题的思路和方法

## 6. 所有用户消息
{{ALL_USER_MESSAGES_VERBATIM}}

## 7. 待办任务
尚未完成的事项

## 8. 当前工作
最近正在做什么；本节必须最详细

## 9. 可能的下一步
接下来计划做什么
```

摘要请求继续使用当前 model，并设置：

- `tools: []`
- `toolChoice: 'none'`
- `thinking: { enabled: false }`
- 每次调用独立使用 `AbortSignal.timeout(options.timeoutMs)`

只持久化 `<summary>...</summary>`；`<analysis>` 草稿不得进入压缩后的上下文。

#### F5.1 所有用户消息原文保证

第 6 节是程序保证，不信任 LLM 自行复制：

1. Controller 从完整、未压缩的 `contextMessages` 提取所有真实 user 消息正文，保持原顺序。
2. `/compact` 命令本身在写入 UI 历史前被拦截，因此不属于用户消息列表。
3. Prompt 要求模型在第 6 节只输出唯一占位符 `{{ALL_USER_MESSAGES_VERBATIM}}`。
4. 解析器校验九个标题顺序和占位符后，以带序号的原文块替换占位符。
5. 用户正文不得 trim、改写、摘要、去重或转义；包装标记不属于用户正文。
6. 若九节、顺序或占位符不合法，摘要结果无效，不得写入上下文。

即使 prompt-too-long 重试丢弃旧 turn，第 6 节仍从完整 `contextMessages` 生成，因此用户原文不丢失。

### F6：Prompt Too Long 降级重试

只有明确的上下文、prompt 或 token 长度错误才执行降级重试；认证 token、限流、网络、超时、协议错误、缺失 `<summary>` 或九节格式错误不得误判为 prompt-too-long。

最大调用序列：

1. 使用完整摘要 turn 调用一次。
2. 若 prompt-too-long，从当前候选头部丢弃 `ceil(10%)`、最少 1 个完整 turn，重试。
3. 再按当前剩余 turn 的 10% 重试，最多连续 3 次 10% 降级。
4. 仍失败时，从当前剩余 turn 头部丢弃 `ceil(20%)`、最少 1 个完整 turn，进行最后一次调用。
5. 总 Provider 调用次数最多 5 次；任一次成功立即停止。
6. 若降级后没有 turn 可发送，直接视为摘要失败，不发送只有摘要指令的请求。

整组内部尝试只对应一次 compact 成败和一次熔断计数变化。

### F7：压缩后关键上下文恢复

#### F7.1 正常或强制摘要成功

最终 `providerContext` 结构：

```text
[0]      role:user      [会话历史摘要] + 九段 summary（第 6 节为程序注入的全部用户原文）
[1]      role:assistant [上下文已压缩] 边界消息
[2]      role:user      最近访问文件路径（可选）
[3]      role:user      Skill 定义（可选；实际索引取决于文件块是否存在）
[后续]                  近期完整 turn 原文
```

#### F7.2 最近访问文件

- 最多恢复 5 个规范化、去重后的路径，不恢复文件正文。
- 选择优先级固定为 `read_file > search_code > glob_files`。
- 同一来源内按最近访问顺序选择。
- 跨来源重复路径只保留优先级最高的一项。
- 输出明确提示模型需要内容时重新调用 `read_file`。

#### F7.3 Skill 定义

本次只提供可注入来源接口，不实现 `/skill` 命令、Skill 加载器或 Skill runtime：

```typescript
interface SkillDefinitionSnapshot {
  id: string;
  renderedContent: string;
  lastUsedOrder: number;
}

interface SkillContextSource {
  getUsedSkillDefinitions(): Promise<readonly SkillDefinitionSnapshot[]>;
}
```

- `ContextManagerOptions.skillContextSource` 可选，默认返回空数组。
- `renderedContent` 由未来 Skill runtime 按原始注入格式提供；ContextManager 不猜测格式或读取磁盘。
- 按 `lastUsedOrder` 从新到旧选择，总预算 25000 近似 tokens。
- 超出预算时只截断最后一个可容纳定义，之后不再注入更旧定义。
- Skill 块位于文件路径块之后、近期 turn 之前。

#### F7.4 重复 compact

ContextManager 维护当前合成前缀长度：

- 下一次 compact 不把旧文件/Skill 恢复块当成真实 turn。
- 旧摘要移除第 6 节用户原文后，与新进入摘要区的完整 turn 一起生成新摘要。
- 文件路径从会话账本重新渲染，Skill 从注入来源重新获取。
- 新前缀一次性替换旧前缀和本次摘要 turn，不嵌套多层摘要或重复恢复块。

### F8：紧急机械兜底

当档位为 emergency 且九段摘要最终失败时，必须执行机械兜底。最终结构：

```text
[0]      role:user      [紧急上下文恢复] + 所有用户消息原文
[1]      role:assistant [上下文已紧急压缩]，明确较早 assistant/tool 信息已丢弃且没有生成摘要
[2]      role:user      最近访问文件路径（可选）
[3]      role:user      Skill 定义（可选）
[后续]                  最近 5 个完整真实 turn
```

要求：

- 所有用户消息仍从完整 `contextMessages` 逐字生成。
- 最近 5 个 turn 必须保持 tool call/result 配对完整。
- 机械兜底不得使用“较早历史已被摘要替代”等误导性文案。
- 机械兜底成功后全量重置 token 估算。
- 如果全部用户原文、Skill 和最近 5 turn 本身已经超过窗口，本规格不允许静默改写或删除用户原文；这是显式残余风险。

### F9：熔断机制

维护 `consecutiveSummaryFailures`：

- 一次自动 compact 的全部摘要尝试最终失败后只增加 1。
- 自动 normal 达到 3 次连续失败后被熔断阻止。
- 自动 force 和 emergency 不受熔断阻止。
- 手动 `/compact` 不受熔断阻止，失败也不增加计数。
- 任意摘要成功将计数重置为 0。
- 自动 emergency 的机械兜底虽然整体成功，但摘要仍然失败，因此增加 1 次失败计数，不重置为 0。
- `circuitOpen === consecutiveSummaryFailures >= 3`。

### F10：手动 `/compact`

`ChatSessionController.parseCommand` 只识别 `/compact`：

- 不保留 `/compress` 别名；`/compress` 按普通用户文本处理。
- `/compact` 在创建和追加用户消息前拦截，不进入 UI 历史。
- 无论当前 estimated 水位如何，都先执行 F2，再调用 `compact(trigger='manual')`。
- 有可摘要历史时使用与自动路径完全相同的摘要、重试和恢复逻辑。
- 无可摘要历史时提示“没有可压缩的历史”。
- 摘要成功提示“上下文已压缩”。
- 紧急机械兜底提示“上下文已紧急压缩，摘要失败后已使用机械兜底”。
- 其他失败提示“上下文压缩失败，请稍后重试”。

### F11：正常 turn 触发时序

每次正常 `submitUserText` 在进入 Agent Loop 前：

1. 解析并拦截 `/compact`；命中后执行 F10 并 return。
2. 创建 UI user 消息，保持现有 streaming 状态流程。
3. 执行 F2 `offloadToolResults(providerContext)`。
4. 无条件调用 `compact(providerContext, { trigger: 'auto', originalUserMessages })`；ContextManager 内部决定跳过、normal、force 或 emergency。
5. 将 compact 后的 `providerContext` 快照传入 Agent Loop。

自动 normal 或 force 摘要失败时保留原上下文并继续 Agent Loop；emergency 已在失败时完成机械兜底。

`loop.failed` 检测到上下文长度类错误时，notice 必须提示“上下文过长，请使用 /compact 压缩后继续”。

## 非功能需求

- **N1：近似 token**：不引入 tokenizer，继续使用字符数除以 4 的近似值。
- **N2：用户原文**：UI 历史不变；压缩后的第 6 节和紧急恢复块由程序逐字注入全部真实用户消息。
- **N3：Provider 协议**：不修改 AgentLoop、OpenAI Provider 或 Anthropic Provider 的公开协议；不得产生孤立 tool result。
- **N4：原子性**：摘要失败时 `providerContext` 保持逐项不变；成功后一次性替换。
- **N5：可测试性**：turn 划分、水位选择、重试裁剪、九节解析、用户原文注入、路径选择和紧急渲染放在纯函数 helper 中独立测试。
- **N6：缓存目录**：`.agentcode/context-cache/` 不存在时递归创建，卸载文件不自动清理。
- **N7：配置边界**：force/emergency margin 仅通过 `ContextManagerOptions` 注入，不扩展配置文件 schema。

## 接口契约

```typescript
interface ContextManagerOptions {
  contextWindow: number;
  offloadThresholdBytes: number;
  turnOffloadThresholdBytes: number;
  cacheDir: string;
  timeoutMs: number;
  forceMargin?: number;
  emergencyMargin?: number;
  skillContextSource?: SkillContextSource;
}

interface CompactionRequest {
  trigger: 'auto' | 'manual';
  originalUserMessages: readonly string[];
}

class ContextManager {
  constructor(provider: ChatModelProvider, model: string, options: ContextManagerOptions);
  onTokenUsage(totalPromptTokens: number): void;
  onMessagesAppended(messages: readonly ChatMessage[]): void;
  get estimated(): number;
  get contextWindow(): number;
  get circuitOpen(): boolean;
  offloadToolResults(messages: ChatMessage[]): Promise<void>;
  compact(messages: ChatMessage[], request: CompactionRequest): Promise<CompactionResult>;
}
```

`ChatMessage` 指 `src/providers/types.ts` 的 Provider 层联合类型。

## 不做的事

- 不实现精确 tokenizer。
- 不实现 `/skill`、Skill 加载或 Skill 使用记录 runtime。
- 不恢复文件正文，不从缓存文件或磁盘主动读取内容。
- 不新增 `/compress` 兼容别名。
- 不开放 YAML 压缩阈值配置。
- 不对摘要做第二个 LLM 质量评分请求。
- 不删除或改写 UI 会话历史。

## 验收标准

- **AC1（F2）**：大于 8 KB 的工具结果被卸载到缓存文件，消息替换为预览；写入失败不破坏原内容。
- **AC2（normal）**：自动 normal 到达水位后生成九段摘要、边界、恢复块和完整近期 turn；低于水位返回 `below_threshold`。
- **AC3（Provider 请求）**：摘要请求 `toolChoice === 'none'`、`tools` 为空、thinking 关闭，并只持久化 `<summary>`。
- **AC4（档位）**：normal、force、emergency 的等号和大于边界均有测试；force/emergency 绕过熔断。
- **AC5（手动）**：`/compact` 在低水位也调用 compact，不进入 UI 历史；`/compress` 不再作为命令。
- **AC6（用户原文）**：最终第 6 节逐字符包含完整 `contextMessages` 中所有 user 正文；模型输出的改写内容不能覆盖程序注入值。
- **AC7（Prompt）**：Prompt 明确要求 `<analysis>` 草稿、`<summary>` 九节正文，且第 8 节最详细。
- **AC8（重试）**：只有 prompt-too-long 执行 3 次 10% 和 1 次 20% 降级；总调用最多 5 次；非长度错误只调用一次。
- **AC9（工具配对）**：普通保留、重试裁剪和紧急兜底均不拆分 assistant tool call 与一个或多个 tool result。
- **AC10（文件路径）**：最多恢复 5 个去重路径，严格按 `read_file > search_code > glob_files` 和同级最近优先，恢复块不含文件正文。
- **AC11（Skill）**：默认 Skill 来源不注入消息；可注入来源按最近使用顺序和 25000 token 总预算恢复。
- **AC12（紧急兜底）**：emergency 摘要最终失败后，仍保留全部用户原文、文件/Skill 恢复和最近 5 个完整 turn，并使用真实的机械截断边界文案。
- **AC13（熔断）**：一次自动 compact 最终失败只计数一次；normal 受熔断，force/emergency/manual 绕过；摘要成功重置。
- **AC14（重复 compact）**：连续多次 compact 不嵌套旧合成块，不把恢复消息计为真实 turn，用户原文仍完整。
- **AC15（原子性）**：normal/force 摘要失败时 Provider 上下文逐项不变；成功或紧急兜底后估算值按最终消息全量重置。
- **AC16（回归）**：`npm run typecheck`、`npm run lint`、相关单测、全量 `npm test` 和 `npm run build` 通过；`npm run e2e:tmux` 可用时通过，不可用时记录环境阻塞。
