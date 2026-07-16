# 会话记忆与指令系统 Spec

## 背景

当前 AgentCode 每次启动都是全新会话：没有项目规则加载、没有历史对话恢复、没有跨会话学习。用户必须在每次对话中重新解释项目背景、纠正偏好、补充上下文，导致体验割裂、重复劳动高。本功能面向所有 AgentCode 用户，尤其是在单一项目中高频使用的开发者。

现有代码基础：`loadDynamicModules` 已能加载 `CLAUDE.md`、`.agentcode/instructions.md`、`.agentcode/memory.md` 三个静态文件注入 system prompt，但无会话存档、无自动笔记生成、无多层指令文件机制。配置目录统一为 `.agentcode/`，本功能在此基础上扩展，不引入新目录。

## 目标

- 启动时自动加载项目规则，让 Agent 无需用户重复说明约定
- 支持恢复上一次会话内容，让跨会话工作连续
- Agent 自动将项目决策和用户偏好写入持久笔记，随时间积累可用知识
- 所有存储均为明文文件，用户可直接查看、编辑、删除

## 功能需求

- F1: 三层指令文件加载。启动时按注入顺序依次加载并拼接：`<project_root>/.agentcode/AGENTCODE.md`（最先注入，最具体）、`<project_root>/AGENTCODE.md`、`~/.agentcode/AGENTCODE.md`（最后注入，全局默认）。某层文件缺失时静默跳过。最终内容注入 system prompt 的新增 `project-rules` slot（order=660，位于现有 `project-context` slot order=650 之后、`custom-instructions` slot order=700 之前）。三层均缺失时该 slot 内容为空字符串，正常启动。

- F2: `@include` 指令支持。`AGENTCODE.md` 文件中可用 `@include <相对路径>` 引入其他文件，相对路径基准为**包含该指令的文件所在目录**。安全规则：先 `path.resolve()` 得到绝对路径，再按文件来源分类处理：项目级文件（`<project_root>/.agentcode/AGENTCODE.md` 或 `<project_root>/AGENTCODE.md`）的 `@include` 目标须在 `projectRoot` 目录内；全局文件（`~/.agentcode/AGENTCODE.md`）的 `@include` 目标须在 `~/.agentcode/` 目录内。超出对应边界的路径抛出明确错误，调用方捕获后记录 warn 日志并跳过该 `@include` 指令，其余内容继续加载。`visited: Set<string>` 防止环路（检测到环路静默跳过）；最大嵌套深度 4，超出后静默截断。

- F3: 单文件软限制。每个指令文件超过 25 KB 时截断到 UTF-8 安全边界，并在内容末尾追加 `...(truncated)`，继续注入截断后的内容。

- F4: 会话存档写入。每次会话产生的消息在每轮完成后以追加方式写入 `.agentcode/sessions/<id>.jsonl`，每次追加仅写入本轮新增消息（不重写全量）。每行为一个消息对象的完整 JSON 序列化，schema 为 `ChatMessage`（`ProviderTextMessage | ProviderAssistantToolCallMessage | ProviderToolResultMessage`）的超集：所有类型共有字段 `role`、`content`；工具调用消息额外包含 `toolCalls`；工具结果消息额外包含 `toolCallId`、`toolName`、`isError`；序列化时统一附加以下非协议字段（带下划线前缀以示区分）：
  - `_ts`：写入时刻的 Unix 毫秒时间戳
  - `_ui`（可选）：TUI 层展示所需字段，结构为 `{ id: string, createdAt: number, author: 'user' | 'agent' }`；仅 user/assistant 文本消息写入此字段，用于恢复后在 TUI 中重建消息列表；工具调用/结果消息省略此字段。
  会话 ID 格式为 `YYYYMMDD-HHMMSS-xxxx`（4 位随机 hex，防同秒撞车）。

- F5: 会话恢复。CLI 支持 `--resume` flag：`agentcode --resume` 启动时扫描当前工作目录对应的 `.agentcode/sessions/` 下的所有 JSONL 文件，按最后修改时间倒序列出最近 10 条会话（展示会话 ID、日期时间、消息数），用户通过方向键选择后加载对应文件，将历史消息重放为 `providerContext`，同时利用 `_ui` 字段重建 TUI 消息列表。接入链：`main.ts` 解析 `--resume` argv → 传入 `BootstrapAppOptions.resumeMode: boolean` → `bootstrapApp` 使用 **Node.js readline**（不使用 Ink SelectInput，避免 TUI 挂载前后的终端状态冲突）在启动 Ink TUI 之前完成会话选择交互 → 将选中的历史 `providerContext`（类型 `ChatMessage[]`）传入 `ChatSessionControllerOptions.initialProviderContext?: ChatMessage[]`，同时将重建的 TUI `messages` 传入 `ChatSessionControllerOptions.initialMessages?: SessionChatMessage[]`。`ChatSessionController` 构造函数收到 `initialProviderContext` 后须调用 `contextManager.onMessagesAppended(initialProviderContext)` 以初始化上下文窗口估算，避免 ContextManager 从空状态开始计算。若 `sessions/` 为空或无可恢复文件，提示"没有可恢复的历史会话"后正常启动新会话。

- F6: 会话恢复异常处理。恢复 JSONL 时按如下顺序处理：
  - JSON 解析失败的行：跳过该行，继续读取后续行，整体恢复不中断。
  - 孤立的工具调用消息（有 `toolCalls` 字段但后续无配对 `toolCallId` 的工具结果消息）：从该条消息处截断，丢弃其后所有内容，截断前的部分正常恢复。
  - 相邻两条消息的 `_ts` 差值超过 86400000 毫秒（24 小时）：在两条消息之间插入一条合成的 `role: user` 消息，内容为 `[距上次对话已超过 N 小时，本段对话发生于 YYYY-MM-DD HH:MM]`，其中 N 向上取整到小时。此合成消息不写入 JSONL，仅存在于内存中的 `providerContext`。
  - token 超限：透传给 `ContextManager` 的 `compact` 流程处理，不在本模块重复实现截断逻辑。

- F7: 惰性会话清理。每次 CLI 启动时读取 `.agentcode/last_cleanup` 文件中的 ISO 8601 时间戳；若距今超过 7 天（或文件不存在/读取失败，视为从未清理），则异步扫描 `.agentcode/sessions/` 目录，删除 `mtime` 超过 30 天的 JSONL 文件，完成后将当前时间以 ISO 8601 格式写回 `last_cleanup`。整个过程非阻塞，失败只写 warn 日志，不中断启动。

- F8: 自动笔记存储结构。笔记以带 YAML frontmatter 的 Markdown 文件存储：用户级保存在 `~/.agentcode/memory/`，项目级保存在 `<project_root>/.agentcode/memory/`。每个目录下维护索引文件 `MEMORY.md`，格式为每行一个指针：`- [标题](文件名.md) — 简述`，索引控制在 200 行 / 25 KB 以内（以先触达者为准）。每条笔记的 frontmatter 包含以下字段：
  ```yaml
  ---
  name: <slug>
  description: <单行摘要>
  metadata:
    type: user | feedback | project | reference
  ---
  ```

- F9: 自动笔记触发条件。每轮 Agent Loop 最终回复结束后判断是否触发笔记更新，满足以下任一条件即触发：
  - 用户消息包含明确的纠正或偏好信号，匹配关键词（中文：不要、记住、以后、别再；英文：don't、remember、always、never、stop）；
  - 最终 assistant 回复的本轮输出 token 数（取 AgentLoop `token.usage` 事件中的 `completionTokens` 字段，若为 `undefined` 视为 0）超过 200，且回复文本中包含反引号围栏代码块（` ``` `，不含行内代码）。
  - 其余情况跳过，不调用 LLM。

- F10: 自动笔记更新流程。触发后在当前轮次响应完成后异步启动，不阻塞当前会话。复用主会话的 provider 实例（相同 model、API key、baseURL），超时与主会话保持一致：
  1. 读取用户级和项目级 `MEMORY.md` 索引内容（如不存在视为空）。
  2. 调用 LLM，输入包含：当前轮次的用户消息全文和 assistant 回复全文、现有两级索引全文。提示 LLM 以 JSON 数组返回操作列表（如 LLM 将 JSON 包裹在 markdown 代码围栏中，提取围栏内容后解析）：
     ```json
     [{ "op": "add|update|delete", "level": "user|project", "title": "string", "filename": "string", "summary": "string", "type": "user|feedback|project|reference", "body": "string" }]
     ```
  3. JSON 解析失败时静默跳过本次更新，写 warn 日志。
  4. 按操作列表逐条执行：`add`/`update` 写笔记文件（原子写：写 `<filename>.tmp` 后 `fs.rename()`）；`delete` 仅从索引移除，对应 `.md` 文件保留在磁盘。
  5. 重建索引文件（原子写）。若重建后索引超过上限，调用 LLM 判断最不重要的一条条目并将其从索引移除（文件保留）；最多执行 3 次裁剪循环，超过后保留当前状态写 warn 日志。

- F11: 上下文注入顺序。会话启动流程依次执行：加载三层 `AGENTCODE.md` → 加载用户级 `MEMORY.md` 索引 → 加载项目级 `MEMORY.md` 索引 → 将以上内容注入 system prompt（`project-rules` slot + 扩展后的 `memory` slot，其中 `memory` slot 替换现有 `loadDynamicModules` 中读取 `.agentcode/memory.md` 的逻辑，改为注入两级 `MEMORY.md` 索引内容；旧 `.agentcode/memory.md` 文件若存在则一并追加，保持向后兼容）→ （如指定 `--resume` 且用户选择了历史会话）将历史消息作为 `initialProviderContext` 传入 `ChatSessionController` → 开始处理请求。

## 非功能需求

- N1: 性能。指令文件和 `MEMORY.md` 索引加载为并行 I/O，在 `bootstrapApp` 阶段预加载完成后作为参数传入 `ChatSessionController`，不阻塞 CLI 启动关键路径；自动笔记更新完全异步，不影响当前会话响应速度。
- N2: 安全性。`@include` 路径解析必须在 `path.resolve()` 之后比较目录前缀（不得在 resolve 前做字符串检查）；超出允许目录的路径抛出明确错误而非静默忽略，防止目录穿越读取系统敏感文件。
- N3: 可靠性。所有文件读取失败（权限不足、文件不存在、解析错误）均静默跳过，不中断启动或当前会话；笔记写入失败只写 warn 日志。
- N4: 竞态安全。自动笔记接受写-读窗口期，不加跨进程文件锁，后写者胜；原子 `rename` 保证单次写操作不产生半写状态。
- N5: 可维护性。所有存储文件均为明文 Markdown 或 JSONL，用户可直接编辑、删除，不需要专用工具。
- N6: 配置目录权限。`.agentcode/sessions/` 和 `.agentcode/memory/` 目录及其下文件按 owner-only 权限（`0o700`/`0o600`）创建，与现有 `.agentcode/` 规范一致。

## 不做的事

- 向量数据库或语义检索（RAG）
- 团队共享记忆或多人协作同步
- 多设备同步
- 笔记 CLI 管理命令（后续 task 可加）
- 对话历史的全文压缩摘要（已由 task08 `ContextManager` 覆盖，不重复实现）
- 独立 meta 文件（会话文件不维护独立的元数据旁路文件）
- 引入 `.mewcode/` 等新配置目录

## 边界与异常

- 三层指令文件均缺失：`project-rules` slot 内容为空字符串，不报错，正常启动。
- `@include` 检测到环路：静默跳过已访问路径，继续处理其余内容。
- `@include` 路径超出允许目录：抛出明确错误，调用方记录 warn 日志并跳过该指令，其余内容继续加载。
- `@include` 嵌套超过深度 4：超出部分静默截断，不报错。
- 指令文件超过 25 KB：截断到 UTF-8 安全边界，追加 `...(truncated)`。
- 会话 JSONL 含坏行（JSON 解析失败）：跳过该行，整体恢复不中断。
- 会话 JSONL 含孤立工具调用（有 `toolCalls` 但无配对工具结果）：从该条消息处截断。
- 会话时间跨度超过 24 小时：插入合成 `role: user` 提醒消息（仅在内存中，不写 JSONL）。
- `--resume` 时 `sessions/` 为空：提示"没有可恢复的历史会话"，正常启动新会话。
- 自动笔记 LLM 调用失败或 JSON 解析失败：静默跳过，写 warn 日志，不影响当前会话。
- `last_cleanup` 不存在或读取失败：触发一次异步清理。
- `MEMORY.md` 索引读取失败：视为空索引，对应 slot 内容为空字符串，不报错。
- 会话恢复时 token 超限：透传给 `ContextManager.compact` 处理。

## 验收标准

- AC1（对应 F1）: 在 `<project_root>/AGENTCODE.md` 写入标记文本 A，在 `<project_root>/.agentcode/AGENTCODE.md` 写入标记文本 B，启动后通过单元测试断言 `project-rules` slot 内容中 B 出现在 A 之前；仅有 `~/.agentcode/AGENTCODE.md` 时也能正常加载；三层均缺失时 `project-rules` slot 返回空字符串且启动无报错。

- AC2（对应 F2）: `AGENTCODE.md` 写入 `@include utils/shared.md`（文件存在且在 `projectRoot` 内），单元测试断言展开后包含目标文件内容；写入 `@include ../../../etc/passwd`（跳出 `projectRoot`），warn 日志中有明确错误记录，返回内容不包含目标文件内容，其余内容正常加载；`~/.agentcode/AGENTCODE.md` 中的 `@include` 目标在 `~/.agentcode/` 外时同样记录 warn 并跳过；构造 A→B→A 环路，单元测试确认加载不死循环且不崩溃；构造 5 层嵌套 `@include` fixture（A→B→C→D→E→F），断言第 5 层（F 的内容）不出现在结果中，且加载不崩溃。

- AC3（对应 F4）: 完成一轮含工具调用的对话后，`.agentcode/sessions/` 下生成符合 `YYYYMMDD-HHMMSS-xxxx.jsonl` 格式的文件；单元测试断言：每行为合法 JSON；纯文本消息行含 `role`、`content`、`_ts`、`_ui`（其中 `_ui.author` 为 `'user'` 或 `'agent'`）；工具调用消息行额外含 `toolCalls`，无 `_ui` 字段；工具结果消息行额外含 `toolCallId`、`toolName`、`isError`，无 `_ui` 字段；新消息追加在文件末尾，不覆盖旧行。

- AC4（对应 F5+F6）: 单元测试提供含一条坏 JSON 行、一条孤立工具调用消息的 JSONL fixture，调用恢复函数后断言：坏行被跳过、孤立工具调用后的内容被截断、有效历史正确重建为 `ChatMessage[]`；提供 `_ts` 差值超过 24 小时的 fixture，断言恢复结果中断点处存在合成提醒消息。

- AC5（对应 F7）: 单元测试注入 `last_cleanup` 内容为 8 天前 ISO 8601 时间戳，在 `sessions/` 下注册 `mtime` 为 31 天前的 JSONL 文件路径，调用清理函数后断言该文件被删除，且清理函数返回 Promise 而非 void（调用方不 await，即非阻塞）。

- AC6（对应 F8+F9+F10）: 单元测试模拟包含"以后不要用 any 类型"的用户消息和 `completionTokens=0` 的 assistant 回复，注入 LLM mock 返回含 `add` 操作的 JSON 数组，await 笔记更新 Promise 完成后，断言：指定路径下生成的 `.md` 文件 frontmatter 含 `metadata.type: feedback`；`MEMORY.md` 索引中出现对应条目指针；索引行数不超过 200 行。另一单元测试模拟 `completionTokens=300` 且回复含 ``` 代码围栏的场景（无触发关键词），断言同样触发笔记更新；模拟 `completionTokens=300` 且回复不含代码围栏的场景，断言不触发笔记更新。

- AC7（对应 F11）: 单元测试对 `loadProjectRules` 函数（封装三层加载逻辑）和 `loadMemoryIndex` 函数单独验证其返回值；集成测试在 `bootstrapApp` 调用链上构造可观察的 `systemPromptRegistry`，断言 `ChatSessionController` 收到的 `systemPromptRegistry` 中 `project-rules` slot 内容非空且包含 `AGENTCODE.md` 标记文本，且该 slot 在 `initialProviderContext` 传入之前已写入 registry。

- AC8（对应 N2）: 单元测试对 `@include` 传入 `../../sensitive`（跳出 `projectRoot`）时，断言函数抛出包含路径信息的 Error；warn 日志记录该错误；最终返回内容不包含目标文件内容；整体加载流程不崩溃。
