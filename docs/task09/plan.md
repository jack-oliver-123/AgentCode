# 会话记忆与指令系统 Plan

## 已批准输入

- spec.md: 4adea65de6e1d10e035d8cec7e0e262f5d31fc19

## 方案摘要

采用"渐进扩展"策略：在现有 `loadDynamicModules` 的并行 I/O 框架基础上扩展，而不是重写。新增独立的功能模块（`loadProjectRules`、`SessionArchive`、`SessionRestore`、`SessionCleaner`、`AutoNoteWriter`），各模块职责单一、可独立测试，然后在 `bootstrapApp` 统一编排。

未采用方案：
- 单文件大函数扩展：可读性差，测试覆盖困难，放弃。
- 引入新配置目录（如 `.mewcode/`）：spec 明确禁止，放弃。
- 向量数据库/RAG：spec 明确不做，放弃。
- 在 `loadDynamicModules` 内部直接堆砌三层加载逻辑：会导致单函数承担过多职责，改为新建 `loadProjectRules.ts` 独立实现，`loadDynamicModules` 调用它。

## 组件与职责

| 组件 | 职责 | 依赖 |
|------|------|------|
| `loadProjectRules` | 加载三层 AGENTCODE.md（含 @include 展开、软限制截断），返回拼接后的字符串 | `node:fs/promises`, `node:path` |
| `resolveIncludes` | 递归展开 @include 指令，维护 visited Set 和深度计数器，执行路径安全检查 | `node:fs/promises`, `node:path` |
| `registry.ts`（修改） | 新增 `project-rules` slot（order=660） | 无新依赖 |
| `loadDynamicModules`（修改） | 在现有三源基础上增加调用 `loadProjectRules`，并修改 memory slot 注入逻辑（两级 MEMORY.md + 旧 memory.md 向后兼容） | `loadProjectRules`, `loadMemoryIndex` |
| `loadMemoryIndex` | 读取用户级和项目级 MEMORY.md 索引，返回合并字符串 | `node:fs/promises`, `node:path` |
| `SessionArchive` | 管理单个会话 JSONL 文件的追加写入；生成会话 ID（YYYYMMDD-HHMMSS-xxxx）；序列化含 `_ts`/`_ui` 扩展字段的消息行 | `node:fs/promises`, `node:path` |
| `SessionRestore` | 扫描 sessions/ 目录，列出最近 10 条会话；解析 JSONL（跳坏行、截断孤立工具调用、插入 24h 合成消息）；返回 `providerContext` 和 TUI `messages` | `node:fs/promises`, `node:path` |
| `SessionCleaner` | 惰性清理：读 `last_cleanup`，扫描 sessions/ 删除 mtime > 30 天的文件，写回时间戳 | `node:fs/promises`, `node:path` |
| `ResumeSelector` | 在 Ink TUI 挂载前用 Node.js readline 交互式列出会话、接收用户选择，返回选中的会话文件路径 | `node:readline`, `SessionRestore` |
| `AutoNoteWriter` | 触发条件判断；调用 LLM 生成操作列表；原子写笔记文件；重建 MEMORY.md 索引；索引裁剪循环 | `node:fs/promises`, `ChatModelProvider` |
| `ChatSessionController`（修改） | 接收 `initialProviderContext`/`initialMessages` 构造参数；构造时若有 `initialProviderContext` 则调用 `contextManager.onMessagesAppended(initialProviderContext)` 初始化 token 估算；维护 per-turn `_turnCompletionTokens` 累积字段（`token.usage` 事件时 += `completionTokens ?? 0`，completeTurn 时读取后重置为 0）；将 `completeTurn` 改为 async，在其中 await `SessionArchive.append` 并 fire-and-forget `AutoNoteWriter.maybeUpdate`；对应地将 `applyAgentLoopEvent` 改为 async | `SessionArchive`, `AutoNoteWriter` |
| `bootstrapApp`（修改） | 编排：并行加载 `loadDynamicModules`（含 `loadProjectRules`/`loadMemoryIndex`）+ 触发 `SessionCleaner.maybeClean`（非阻塞）；若 `resumeMode=true` 则调用 `ResumeSelector`；将结果传入 `ChatSessionController` | 所有新模块 |
| `main.ts`（修改） | 在 `main()` 中解析 `process.argv`，检测 `--resume` flag，直接调用 `bootstrapApp({ resumeMode: true })` 而非通过 `runCli()`；`runCli()` 签名与 `RunCliOptions` 不变，保持可测试入口不受影响 | `bootstrapApp` |

## 交互与数据流

### 启动流程（含 --resume）

```
main.ts
  └─ 解析 argv --resume → BootstrapAppOptions.resumeMode=true
       └─ bootstrapApp()
            ├─ loadConfig()
            ├─ [并行]
            │   ├─ loadDynamicModules(cwd)
            │   │    ├─ loadProjectRules(cwd, homeDir)   → project-rules slot
            │   │    ├─ loadMemoryIndex(cwd, homeDir)    → memory slot
            │   │    └─ [旧逻辑] CLAUDE.md / instructions.md / memory.md(兼容)
            │   └─ SessionCleaner.maybeClean(cwd)        → 非阻塞 void
            │
            ├─ [若 resumeMode]
            │   └─ ResumeSelector.pick(cwd)              → readline 交互
            │        └─ SessionRestore.listSessions(cwd) → 会话列表
            │        └─ SessionRestore.loadSession(path) → { providerContext, messages }
            │
            ├─ createProvider()
            ├─ new ChatSessionController({
            │      systemPromptRegistry,
            │      initialProviderContext?,   ← 来自 SessionRestore
            │      initialMessages?,          ← 来自 SessionRestore
            │  })
            └─ renderApp(<App controller={controller} />)
```

### 每轮对话写入流程

```
ChatSessionController.submitUserText()
  └─ runAgentLoop()  → loop.completed
       └─ completeTurn(userMessage, finalText, turnMessages)
            ├─ [已有] 更新 providerContext / contextMessages
            ├─ SessionArchive.append(newMessages)          → await（写 JSONL）
            └─ AutoNoteWriter.maybeUpdate({userText, assistantText, completionTokens: this._turnCompletionTokens})
                 └─ [不 await，后台异步]
                      ├─ shouldTrigger() 判断
                      ├─ loadMemoryIndex() 读两级索引
                      ├─ provider.stream() 调用 LLM
                      ├─ 解析 JSON 操作列表
                      └─ 原子写笔记文件 + 重建索引
```

## 接口与数据结构

### loadProjectRules

- 输入：`cwd: string`，`homeDir: string`
- 输出：`Promise<string>`（三层拼接内容，均缺失时返回 `''`）
- 错误：内部捕获所有 I/O 错误，写 warn 日志后静默跳过

### resolveIncludes

- 输入：`content: string`，`baseDir: string`，`allowedRoot: string`，`visited: Set<string>`，`depth: number`
- 输出：`Promise<string>`（展开后文本）
- 错误：路径超出 `allowedRoot` 时抛出 `Error`，调用方捕获后写 warn 并跳过该行

### loadMemoryIndex

- 输入：`cwd: string`，`homeDir: string`
- 输出：`Promise<string>`（用户级 + 项目级 MEMORY.md 合并文本，读取失败视为空）
- 错误：静默跳过，返回空字符串

### loadDynamicModules（签名变更）

现有签名 `loadDynamicModules(cwd: string)` 扩展为 `loadDynamicModules(cwd: string, homeDir: string)`。调用方 `bootstrapApp` 已有 `homeDir` 来源（`options.homeDir ?? os.homedir()`），同步更新调用处。

### SessionArchive

```typescript
interface SessionArchiveOptions {
  sessionsDir: string;   // <cwd>/.agentcode/sessions/
}

class SessionArchive {
  readonly sessionId: string;  // YYYYMMDD-HHMMSS-xxxx
  constructor(options: SessionArchiveOptions)
  // 目录不存在时以 0o700 权限创建，文件以 0o600 权限写入（N6）
  async append(messages: ProviderChatMessage[]): Promise<void>
}
```

- 写入格式：每行一个 JSON 对象，附加 `_ts: number`；user/assistant 文本消息附加 `_ui: { id, createdAt, author }`
- 错误：写入失败只写 warn 日志，不抛出

### SessionRestore

```typescript
// session/types.ts 中的 ChatMessage（TUI 层，含 id/role/parts/createdAt）
import type { ChatMessage as SessionMessage } from '../session/types.js';

interface SessionSummary {
  filePath: string;
  sessionId: string;
  messageCount: number;
  lastModified: Date;
}

interface RestoredSession {
  providerContext: ProviderChatMessage[];
  messages: SessionMessage[];  // TUI ChatMessage（session/types.ts），非 providers/types.ts 同名类型
}

function listSessions(cwd: string): Promise<SessionSummary[]>
function loadSession(filePath: string): Promise<RestoredSession>
```

- 错误：坏 JSON 行跳过；孤立工具调用截断；24h 间隔插入合成消息

### ResumeSelector

```typescript
function pickSession(cwd: string): Promise<RestoredSession | null>
// null = 无历史或用户取消，调用方正常启动新会话
```

- 实现：Node.js `readline`，在 Ink TUI 挂载前运行，不使用 Ink SelectInput

### SessionCleaner

```typescript
function maybeClean(cwd: string): Promise<void>
// 调用方不 await，fire-and-forget
```

- 读取 `<cwd>/.agentcode/last_cleanup`；超过 7 天则异步删除 mtime > 30 天的文件，写回时间戳
- 错误：任何阶段失败只写 warn 日志

### AutoNoteWriter

```typescript
interface AutoNoteWriterOptions {
  provider: ChatModelProvider;
  model: string;
  timeoutMs: number;   // 取 resolvedConfig.config.request.timeoutMs，与主会话一致（F10）
  cwd: string;
  homeDir: string;
}

class AutoNoteWriter {
  constructor(options: AutoNoteWriterOptions)
  maybeUpdate(params: {
    userText: string;
    assistantText: string;
    completionTokens: number;   // 来自 controller 的 per-turn 累积字段 _turnCompletionTokens
  }): Promise<void>
  // 调用方不 await
}
```

- 触发条件：关键词匹配 OR（completionTokens > 200 AND 回复含 ``` 代码围栏）
- LLM 返回格式：`Array<{ op, level, title, filename, summary, type, body }>`
- 原子写：先写 `<filename>.tmp`，再 `fs.rename()`；memory/ 目录以 0o700 创建，文件以 0o600 写入（N6）
- 错误：LLM 失败或 JSON 解析失败，静默跳过，写 warn 日志

### ChatSessionControllerOptions 新增字段

```typescript
// session/types.ts 的 ChatMessage（TUI 层）
import type { ChatMessage as SessionMessage } from '../session/types.js';

interface ChatSessionControllerOptions {
  // ... 现有字段 ...
  initialProviderContext?: ProviderChatMessage[];   // F5: 恢复的历史 provider context
  initialMessages?: SessionMessage[];               // F5: 恢复的 TUI 消息列表（session/types.ts ChatMessage）
  sessionArchive?: SessionArchive;                  // F4: 会话存档（可注入，便于测试）
  autoNoteWriter?: AutoNoteWriter;                  // F9/F10: 自动笔记（可注入，便于测试）
  homeDir?: string;                                 // 已有，用于笔记路径
}
```

构造函数新增行为：
- 若 `initialProviderContext` 非空，赋值给 `this.providerContext` 后**立即**调用 `this.contextManager.onMessagesAppended(initialProviderContext)`，确保 ContextManager token 估算从正确基线开始（F5 spec 明确要求）。
- 若 `initialMessages` 非空，赋值给 `this.messages`，TUI 恢复后可见历史。
- 新增私有字段 `private _turnCompletionTokens = 0`；在 `applyAgentLoopEvent` 的 `token.usage` 分支中 `+= (event.completionTokens ?? 0)`；在 `completeTurn` 开始时读取该值传给 `AutoNoteWriter.maybeUpdate`，然后重置为 0。

### BootstrapAppOptions 新增字段

```typescript
interface BootstrapAppOptions extends LoadConfigOptions {
  // ... 现有字段 ...
  resumeMode?: boolean;   // --resume flag
}
```

### JSONL 行 schema（扩展 ProviderChatMessage）

```typescript
// 纯文本消息
interface ArchivedTextMessage {
  role: 'user' | 'assistant';
  content: string;
  _ts: number;
  _ui: { id: string; createdAt: number; author: 'user' | 'agent' };
}

// 工具调用消息
interface ArchivedToolCallMessage {
  role: 'assistant';
  content: string;
  toolCalls: ProviderToolCall[];
  _ts: number;
  // 无 _ui
}

// 工具结果消息
interface ArchivedToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  _ts: number;
  // 无 _ui
}
```

## 文件组织

| 操作 | 路径 | 目的 |
|------|------|------|
| 新建 | `src/system-prompt/loadProjectRules.ts` | 三层 AGENTCODE.md 加载 + @include 展开 |
| 新建 | `src/system-prompt/loadMemoryIndex.ts` | 读取两级 MEMORY.md 索引 |
| 修改 | `src/system-prompt/registry.ts` | 新增 `project-rules` slot（order=660） |
| 修改 | `src/system-prompt/loadDynamicModules.ts` | 集成 loadProjectRules + loadMemoryIndex，memory slot 扩展向后兼容 |
| 修改 | `src/system-prompt/index.ts` | 导出 loadProjectRules, loadMemoryIndex |
| 新建 | `src/session/SessionArchive.ts` | 会话 JSONL 追加写入 |
| 新建 | `src/session/SessionRestore.ts` | 会话扫描、解析、异常处理 |
| 新建 | `src/session/SessionCleaner.ts` | 惰性清理逻辑 |
| 新建 | `src/session/ResumeSelector.ts` | readline 交互式会话选择 |
| 修改 | `src/session/ChatSessionController.ts` | 接收 initialProviderContext/initialMessages；completeTurn 后触发存档和自动笔记 |
| 修改 | `src/session/types.ts` | 无新增公共类型（内部类型在各新文件中定义） |
| 新建 | `src/notes/AutoNoteWriter.ts` | 触发判断 + LLM 调用 + 原子写 + 索引重建 |
| 修改 | `src/app/bootstrapApp.tsx` | 编排新模块；处理 resumeMode；传入 initialProviderContext/initialMessages |
| 修改 | `src/cli/main.ts` | 解析 `--resume` argv，传入 BootstrapAppOptions.resumeMode |
| 新建 | `tests/unit/system-prompt/loadProjectRules.test.ts` | AC1, AC2, AC8 |
| 新建 | `tests/unit/session/SessionArchive.test.ts` | AC3 |
| 新建 | `tests/unit/session/SessionRestore.test.ts` | AC4 |
| 新建 | `tests/unit/session/SessionCleaner.test.ts` | AC5 |
| 新建 | `tests/unit/notes/AutoNoteWriter.test.ts` | AC6 |
| 新建 | `tests/unit/system-prompt/loadMemoryIndex.test.ts` | AC7 部分（loadMemoryIndex 返回值验证） |
| 新建 | `tests/integration/bootstrapApp-resume.test.ts` | AC7 集成（systemPromptRegistry 中 project-rules slot 非空；initialProviderContext 后 ContextManager 基线正确） |

## 兼容性与迁移

- `project-context` slot（order=650）、`custom-instructions` slot（order=700）、`memory` slot（order=800）保持不变，order 值不调整。
- 新增 `project-rules` slot（order=660）夹在 `project-context` 与 `custom-instructions` 之间，对现有注册表无破坏性影响。
- 旧 `.agentcode/memory.md` 文件若存在，在 memory slot 中追加到两级 MEMORY.md 索引内容之后，向后兼容。
- `ChatSessionControllerOptions` 新增字段均为可选，构造函数不改变已有参数的默认行为。
- `BootstrapAppOptions` 新增 `resumeMode?: boolean`，默认 undefined（等同 false），现有调用方无需改动。
- `defaultRegistry` 新增 `project-rules` 条目后，所有依赖 `defaultRegistry` 的测试 mock 需补充该条目；通过 `npx tsc --noEmit` 可一次性发现所有遗漏。

## 验证策略

- 单元验证：
  - `npm test -- tests/unit/system-prompt/loadProjectRules.test.ts`（AC1, AC2, AC8）
  - `npm test -- tests/unit/session/SessionArchive.test.ts`（AC3）
  - `npm test -- tests/unit/session/SessionRestore.test.ts`（AC4）
  - `npm test -- tests/unit/session/SessionCleaner.test.ts`（AC5）
  - `npm test -- tests/unit/notes/AutoNoteWriter.test.ts`（AC6）
  - `npm test -- tests/unit/system-prompt/loadMemoryIndex.test.ts`（AC7）
  - `npm run typecheck`（全量类型检查，发现 mock 缺失字段）

- 集成验证：
  - 在 `bootstrapApp` 调用链上构造可观察的 `systemPromptRegistry`，断言 `project-rules` slot 非空（AC7）
  - 构造临时目录放置 AGENTCODE.md，运行 `npm run dev` 后检查 system prompt 输出中包含标记文本

- 端到端验证：
  - `npm run e2e:tmux`：启动完整 TUI，发送一轮消息，验证 `.agentcode/sessions/` 下生成 JSONL 文件
  - `npm run e2e:tmux`（带 `--resume`）：启动后通过 readline 选择历史会话，验证 TUI 中历史消息可见
  - 手动验证：在项目根写 AGENTCODE.md，重启 CLI，确认 Agent 能感知其中规则

## 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|------|------|------|------|
| readline 与 Ink TUI 终端状态冲突 | --resume 流程卡死或显示乱码 | readline 交互在 `renderApp()` 调用前完成并关闭 rl 实例；在 CI 环境（非 TTY）中检测到非 TTY 时跳过交互，直接返回 null | 回退 `ResumeSelector` 实现，改为命令行参数直接传 session ID（`--resume=<id>`） |
| defaultRegistry 新增 slot 破坏现有 mock | 大量测试编译报错 | 实现后立即运行 `npx tsc --noEmit`，批量修复 mock | 该 slot 仅是 `{ id, order, content }` 追加，恢复只需删除该条目 |
| AutoNoteWriter 异步写入与 ContextManager compact 竞态 | 笔记写入时 provider context 已被压缩，内容不一致 | AutoNoteWriter 在 `completeTurn` 时捕获当轮 userText/assistantText 快照，不引用 providerContext 引用，避免竞态 | 关闭自动笔记（`autoNoteWriter` 不传入 controller） |
| 会话 JSONL 文件快速增长 | 磁盘占用过大 | SessionCleaner 30 天自动清理；每条 JSONL 只存文本消息，工具 stdout/stderr 通过现有 summarize 机制已截断 | 用户手动删除 `.agentcode/sessions/` 目录 |
| LLM 笔记更新调用消耗额外 token/费用 | 用户账单增加 | 触发条件设置为高门槛（>200 completion tokens + 代码围栏，或明确关键词）；失败静默跳过，不重试 | 不传入 `autoNoteWriter` 到 ChatSessionController，特性完全关闭 |
| @include 路径安全检查遗漏绕过手段 | 读取系统敏感文件 | 必须先 `path.resolve()` 再做前缀比较（N2 要求）；超出允许目录时抛出错误而非静默跳过，确保 warn 日志可审计 | 禁用 @include 展开（`resolveIncludes` 直接返回原文） |
