# 斜杠命令框架与运行时控制 Plan

## 已评审输入

- spec.md: `034bb429762af17fc2c4890f851c9721c6ef13a2`（当前版本已通过 3 个只读 reviewer，状态：reviewed-unapproved；未取得用户整文档批准前不得把该 hash 视为 approved）

## 方案摘要

采用“**App 级命令框架 + 会话工作区 + 事件驱动运行时**”方案，而不是继续在 `ChatSessionController` 内追加正则分支。核心原则：

1. **slash 输入先于 Agent 路由**：`InputRouter` 在 App 层把 slash command、本地运行中控制和普通 prompt 分流。
2. **命令 handler 纯逻辑**：命令对象只读 snapshot 并返回 typed actions，不直接操作 Ink、文件系统或 Provider。
3. **单一 AppRuntime**：所有命令动作、Agent Loop 事件、modal 结果和 session 切换最终转成 typed `AppEvent`，由一个 runtime 顺序归并为统一快照，React 只订阅快照渲染。
4. **SessionWorkspace 管理 controller 生命周期**：`/clear`、`/session resume` 不在 controller 内自我重置，而是构造新 controller 后原子替换活动实例，并管理持久 Queue、session lock、元数据与恢复。
5. **Review 作为隔离 operation**：不复用主会话 Provider context，采用只读 `ReviewRunner`，冻结目标快照并只把结构化 findings 写回主 session。
6. **Plan/Review 只读是 Agent 数据面只读**：阻止模型与 review runner 通过工具写 repo/workspace/config/memory/permission；用户显式触发的 AgentCode 控制面写入可执行，但必须走确认、再校验和审计。
7. **Codex 风格 Steer + 持久 Queue**：运行中 Enter steer、Alt+Enter queue。Steer 在下一安全模型边界注入；Queue 为 session-scoped 持久 FIFO，由 drain scheduler 驱动。

未采用方案：

- **继续把 `/compact`、`/plan`、`/do` 写在 `ChatSessionController.parseCommand()`**：会把 UI 命令、会话切换、持久化、memory、review workflow 都塞进 session controller，职责继续膨胀，不适合 `/clear` 原子切 session、运行中 queue/steer、help/panel/modal 等场景。
- **在 InputPane/React hook 内直接分流并操作状态**：会把 parser、registry、modal、session 切换和 App 状态散落进组件和 hook，难以 headless 复用，也不利于 typed 审计和测试。
- **把 Review 实现成普通 prompt preset**：会污染主 Provider context、把中间 diff/tool 输出写入主对话，并让只读边界依赖 prompt 自觉性，而非架构约束。
- **把 Queue 做成内存临时数组**：无法满足 session 恢复、`/stop` 后保留、重启恢复和 deterministic drain 的需求。
- **通用 subagent 系统先行**：超出本轮范围；Review 先以专用 `ReviewRunner` 落地，后续如引入 subagent 再替换内部实现，不改变命令契约。

## 组件与职责

| 组件 | 职责 | 依赖 |
|------|------|------|
| `CommandParser` | 识别 slash 输入，输出 canonical command、`rawArguments`、quoted `argv`、错误位置与 parser diagnostics | 无 I/O，纯函数 |
| `CommandRegistry` | 注册 built-in commands 与 metadata，alias/hidden/userInvocable/source/namespace 管理，冲突校验，seal 后只读 | 纯内存数据结构 |
| `InputRouter` | App 级输入路由：slash → command dispatcher；普通消息 → session workspace；运行中 Enter/Alt+Enter 键位映射 steer/queue | `CommandParser`, `CommandDispatcher`, `SessionWorkspace` |
| `CommandDispatcher` | preflight + commit；调用命令 handler，检查 operation 级 active-run policy、能力、目标存在性、可用性；执行 typed actions | `AppRuntime`, `SessionWorkspace`, `InteractionCoordinator` |
| `Command` handlers | 每个 built-in 命令的纯逻辑：根据 snapshot 和参数返回 `CommandResult` | 只读 `CommandContext` snapshot |
| `CommandContextBuilder` | 从 AppRuntime/SessionWorkspace/permission/memory/MCP 构造不可变 snapshot 供 handler 使用 | `SessionWorkspace`, managers |
| `InteractionCoordinator` | 统一管理 session picker、memory delete、permission remove、queue remove/clear、tool approval 等 request/response 生命周期与 idempotency | `AppRuntime`, request store |
| `AppRuntime` | 命令动作、Agent Loop 事件、modal 结果的统一事件总线与快照归并器；发布 `AppSnapshot` 给 React | 无 UI 逻辑，负责状态机 |
| `SessionWorkspace` | 管理活动 session metadata、活动 `ChatSessionController`、session locks、session-scoped queue、新建/恢复/重命名/持久化 | `SessionArchive`, `SessionRestore`, queue store |
| `QueueStore` | session-scoped 持久 FIFO queue，支持 add/list/run/remove/clear、paused 状态、drain scheduler、Agent mode 冻结 | filesystem + session metadata |
| `PermissionManager` | 维护可热更新的 permission snapshot、generation、mode 选择、rules 视图、atomic 写入/重载和 audit | existing permission config/checker |
| `MemoryManager` | 枚举用户级/项目级 memory 索引、读取条目、删除条目及安全校验 | `loadMemoryIndexes`, fs |
| `ReviewRunner` | 冻结 review target（worktree/branch/GitHub PR）、构造只读 review prompt、运行隔离 provider/tool loop、输出结构化 findings | provider + read-only tool registry |
| `StatusService` | 聚合 runtime/session/context/token/MCP/Git/memory/permission 状态，为状态栏与 `/status` 面板提供 snapshot | `SessionWorkspace`, `ContextManager`, MCP manager |
| `PromptInputModel` | 替代 `InputPane` 内部简单 state，支持 draft、accepted/failed routing、运行中 steer/queue 提交后清空或保留 | React local state + AppRuntime callbacks |

## 交互与数据流

### 1. 普通输入与 slash 分流

```text
InputPane (raw text, keypress)
  -> InputRouter.route(rawText, keyIntent, AppSnapshot)
      -> if slash:
           CommandParser.parse(rawText)
           -> CommandDispatcher.dispatch(parsed, snapshot)
                -> handler.execute(contextSnapshot, parsedArgs)
                -> preflight checks
                -> commit typed CommandAction[]
                -> AppRuntime.dispatch(AppEvent...)
      -> else if active run + Enter:
           SessionWorkspace.steer(rawText)
      -> else if active run + Alt+Enter:
           SessionWorkspace.queueAdd(rawText)
      -> else:
           SessionWorkspace.submitPrompt(rawText)
```

### 2. 会话创建、恢复与切换

```text
/clear [name]
  -> CommandDispatcher preflight
  -> SessionWorkspace.createCandidateSession({ name, agentMode: default, permissionMode: selected })
  -> acquire session lock
  -> build new ChatSessionController
  -> AppRuntime.dispatch(session.activated)
  -> old controller released

/session resume <id-or-name>
  -> parse target
  -> SessionWorkspace.resolveSession(target)
  -> lock check / stale validation
  -> SessionRestore.loadSession(...)
  -> build candidate controller with restored providerContext/messages
  -> activate atomically or fail without replacing active session
```

### 3. 运行中 Steer

```text
Enter while active run
  -> InputRouter -> SessionWorkspace.steer(text)
  -> append typed steer event to active run control queue
  -> active AgentLoop continues current stream/tool
  -> before next model call boundary:
       merge steer messages in order
       inject guidance block into current turn context
  -> AppRuntime appends steer activity to transcript + archive
```

### 4. 持久 Queue 与 drain

```text
Alt+Enter or /queue add <text>
  -> QueueStore.appendItem(sessionId, text, frozenAgentMode)
  -> atomic persist success
  -> if queue empty && not paused && no active run:
       scheduler starts drain with same queue item
  -> else remain queued

Normal turn completed
  -> scheduler dequeues next item
  -> create run using item.agentMode + current permission mode
  -> continue until queue empty

Stop/fail/recover
  -> queue remains persisted
  -> paused=true
  -> /queue run resumes scheduler
```

### 5. 隔离 Review Operation

```text
/review [target]
  -> local parse + preflight
      - resolve repo root
      - freeze target identity
      - worktree: HEAD SHA + diff hash + file snapshot
      - branch: base ref SHA + head SHA
      - PR: GitHub repo identity + base/head SHA via gh/API
  -> create ReviewRunner context (read-only tools only)
  -> run isolated provider loop
  -> produce typed ReviewResult { target, findings, summary }
  -> AppRuntime appends review activity to transcript/archive
  -> restore prior AgentMode/Permission UI state
```

### 6. 多步交互与再校验

```text
/memory delete project foo.md
  -> command returns request_confirmation
  -> InteractionCoordinator stores request { type, id, sessionId, targetFingerprint, activeRunPolicy, modeSnapshot }
  -> user confirms
  -> coordinator rechecks:
       request still active
       current session unchanged
       operation policy still allowed
       target fingerprint still matches
  -> MemoryManager.delete(...)
  -> AppRuntime.dispatch(memory.deleted)
```

## 接口与数据结构

### `CommandMetadata`

```ts
interface CommandMetadata {
  name: string;
  aliases: readonly string[];
  summary: string;
  category: 'general' | 'conversation' | 'mode' | 'workspace' | 'workflow' | 'runtime';
  argumentMode: 'none' | 'raw' | 'argv';
  usage: readonly string[];
  examples: readonly { invocation: string; description: string }[];
  argumentHint?: string;
  execution: 'local' | 'prompt' | 'hybrid';
  effects: readonly ('ui' | 'session' | 'mode' | 'config' | 'model')[];
  activeRunPolicy: 'immediate' | 'queue' | 'reject';
  hidden: boolean;
  userInvocable: boolean;
  source: { type: 'builtin' } | { type: 'skill'; id: string; namespace?: string } | { type: 'plugin'; id: string; namespace: string };
}
```

### `ParsedCommandInput` / `ParsedCommandOperation`

```ts
interface ParsedCommandInput {
  raw: string;
  commandName: string;
  rawArguments: string;
  argv: readonly string[];
}

type ParsedCommandOperation =
  | { kind: 'help.open'; activeRunPolicy?: 'immediate' }
  | { kind: 'help.detail'; command: string; activeRunPolicy?: 'immediate' }
  | { kind: 'session.current'; activeRunPolicy?: 'immediate' }
  | { kind: 'session.resume'; target: string; activeRunPolicy?: 'reject' }
  | { kind: 'session.rename'; name: string; activeRunPolicy?: 'immediate' }
  | { kind: 'memory.show'; scope: 'user' | 'project'; entry: string; activeRunPolicy?: 'immediate' }
  | { kind: 'memory.delete'; scope: 'user' | 'project'; entry: string; activeRunPolicy?: 'immediate' }
  | { kind: 'permission.mode'; mode: PermissionMode; activeRunPolicy?: 'immediate' }
  | { kind: 'permission.remove'; scope: PermissionScope; ruleId: string; activeRunPolicy?: 'immediate' }
  | { kind: 'review.worktree'; focus?: string; activeRunPolicy?: 'reject' }
  | { kind: 'review.branch'; branch: string; focus?: string; activeRunPolicy?: 'reject' }
  | { kind: 'review.pr'; target: string; focus?: string; activeRunPolicy?: 'reject' }
  | { kind: 'queue.add'; text: string; activeRunPolicy?: 'immediate' }
  | { kind: 'queue.list'; activeRunPolicy?: 'immediate' }
  | { kind: 'queue.run'; activeRunPolicy?: 'reject' }
  | { kind: 'queue.remove'; index: number; activeRunPolicy?: 'immediate' }
  | { kind: 'queue.clear'; activeRunPolicy?: 'immediate' }
  | { kind: 'steer'; text: string; activeRunPolicy?: 'immediate' }
  | { kind: 'stop'; activeRunPolicy?: 'immediate' }
  | { kind: 'clear'; name?: string; activeRunPolicy?: 'reject' }
  | { kind: 'compact'; instructions?: string; activeRunPolicy?: 'reject' }
  | { kind: 'mode.plan'; prompt?: string; activeRunPolicy?: 'reject' }
  | { kind: 'mode.default'; prompt?: string; activeRunPolicy?: 'reject' };
```

### `CommandResult` / `CommandAction`

```ts
type CommandResult =
  | { kind: 'handled'; actions: readonly CommandAction[] }
  | { kind: 'rejected'; error: CommandError };

type CommandAction =
  | { type: 'show_notice'; level: 'info' | 'warn' | 'error'; text: string; ttlMs?: number }
  | { type: 'append_command_output'; command: string; content: string }
  | { type: 'open_panel'; panel: PanelDescriptor }
  | { type: 'open_modal'; request: InteractionRequest }
  | { type: 'set_agent_mode'; mode: AgentMode; selectedPermissionMode?: PermissionMode }
  | { type: 'submit_prompt'; text: string; agentMode: AgentMode }
  | { type: 'create_session'; name?: string }
  | { type: 'activate_session'; sessionId: string }
  | { type: 'rename_session'; sessionId: string; name: string }
  | { type: 'delete_memory'; scope: 'user' | 'project'; entry: string }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'remove_permission_rule'; scope: PermissionScope; ruleId: string }
  | { type: 'start_review'; target: ReviewTargetInput }
  | { type: 'queue_add'; text: string }
  | { type: 'queue_run' }
  | { type: 'queue_remove'; index: number }
  | { type: 'queue_clear' }
  | { type: 'steer'; text: string }
  | { type: 'stop_run' };
```

### `CommandContext` snapshots

```ts
interface CommandContext {
  app: {
    activeRun: {
      exists: boolean;
      phase: 'streaming' | 'tool_running' | 'awaiting_permission' | 'retry_backoff' | 'idle';
      agentMode: AgentMode;
      permissionModeSelected: PermissionMode;
      permissionModeEffective: 'readonly' | PermissionMode;
      queueCount: number;
      reviewActive: boolean;
    };
  };
  session: SessionSnapshot;
  permissions: PermissionSnapshot;
  memory: MemoryIndexSnapshot;
  status: StatusSnapshot;
}
```

### `SessionWorkspace`

```ts
interface SessionWorkspace {
  getActiveSnapshot(): SessionSnapshot;
  submitPrompt(text: string): Promise<RouteAcceptance>;
  steer(text: string): Promise<RouteAcceptance>;
  queueAdd(text: string): Promise<RouteAcceptance>;
  queueRun(): Promise<CommandExecutionResult>;
  stopRun(): Promise<CommandExecutionResult>;
  createSession(options: { name?: string; agentMode: AgentMode; selectedPermissionMode: PermissionMode }): Promise<SessionActivationResult>;
  resumeSession(target: SessionSelector): Promise<SessionActivationResult>;
  renameSession(name: string): Promise<void>;
  listSessions(): Promise<readonly SessionSummary[]>;
}
```

Key design points:
- active controller is replaceable;
- session-scoped queue is persisted outside `ChatSessionController`;
- lock management is part of workspace/store, not command handlers.

### `PermissionManager`

```ts
interface PermissionSnapshot {
  selectedMode: PermissionMode;
  effectiveMode: 'readonly' | PermissionMode;
  generation: number;
  counts: { session: number; project: number; global: number };
}

interface PermissionManager {
  snapshot(): PermissionSnapshot;
  setSelectedMode(next: PermissionMode): Promise<{ generation: number }>;
  removeRule(scope: PermissionScope, ruleId: string): Promise<{ generation: number }>;
  getRuleViews(scope?: PermissionScope): Promise<readonly PermissionRuleView[]>;
}
```

Key design points:
- every successful mutation increments `generation`;
- tool execution preflight reads the latest generation, not a run-wide frozen copy;
- widening permission while active run exists requires explicit confirmation and audit;
- Plan/Review readonly cap is applied above selected mode.

### `MemoryManager`

```ts
interface MemoryManager {
  list(): Promise<MemoryIndexSnapshot>;
  read(scope: 'user' | 'project', entry: string): Promise<MemoryEntryContents>;
  delete(scope: 'user' | 'project', entry: string): Promise<void>;
}
```

Key design points:
- uses existing `loadMemoryIndexes` / memory roots;
- delete performs fingerprint validation and atomic index rewrite + file unlink;
- no add/edit in this phase.

### `ReviewRunner`

```ts
type ReviewTargetInput =
  | { kind: 'worktree'; focus?: string }
  | { kind: 'branch'; branch: string; focus?: string }
  | { kind: 'pr'; target: string; focus?: string };

interface FrozenReviewTarget {
  kind: 'worktree' | 'branch' | 'pr';
  repoRoot: string;
  repoIdentity?: { host: 'github.com'; owner: string; repo: string };
  baseSha: string;
  headSha: string;
  diffHash: string;
  focus?: string;
  metadata: Record<string, string>;
}

interface ReviewResult {
  target: FrozenReviewTarget;
  findings: readonly ReviewFinding[];
  summary: string;
}
```

Key design points:
- worktree freezes current HEAD + diff hash + file snapshot;
- branch freezes current HEAD and resolved base ref SHA;
- PR uses GitHub only in phase 1, validates repo identity, and freezes API-returned base/head SHA even for forks;
- runner uses read-only tool registry and dedicated provider context;
- result is persisted as typed review activity, not automatically appended to provider context.

### `InteractionCoordinator`

```ts
type InteractionRequest =
  | { kind: 'session-picker'; id: string; idempotencyKey: string }
  | { kind: 'confirm-memory-delete'; id: string; scope: 'user' | 'project'; entry: string; fingerprint: string; idempotencyKey: string }
  | { kind: 'confirm-permission-remove'; id: string; scope: PermissionScope; ruleId: string; generation: number; idempotencyKey: string }
  | { kind: 'confirm-queue-remove'; id: string; index: number; queueVersion: number; idempotencyKey: string }
  | { kind: 'confirm-queue-clear'; id: string; queueVersion: number; idempotencyKey: string }
  | { kind: 'tool-approval'; id: string; requestId: number; ... };
```

Key design points:
- request completion checks current session id, operation active-run policy, relevant mode cap, and fingerprint/version;
- idempotency key prevents duplicate side effects on repeated confirmation delivery;
- existing tool permission flow can be bridged without losing its own typed semantics.

## 文件组织

| 操作 | 路径 | 目的 |
|------|------|------|
| 新建 | `src/commands/` | 命令框架：parser、registry、metadata、errors、dispatcher、built-ins |
| 新建 | `src/app/runtime/` | `AppRuntime`、`InputRouter`、snapshot/event types |
| 新建 | `src/app/session/SessionWorkspace.ts` | 活动 controller 生命周期、session 锁、queue 协调 |
| 新建 | `src/app/session/SessionQueueStore.ts` | session-scoped 持久 queue |
| 新建 | `src/app/interaction/InteractionCoordinator.ts` | typed modal/picker/confirm 生命周期 |
| 新建 | `src/app/review/ReviewRunner.ts` | 隔离只读 review operation |
| 新建 | `src/app/status/StatusService.ts` | 详细状态面板与状态栏快照 |
| 新建 | `src/app/permissions/PermissionManager.ts` | mode/rules 视图、重载、generation/audit |
| 新建 | `src/app/memory/MemoryManager.ts` | memory list/show/delete 管理 |
| 修改 | `src/app/bootstrapApp.tsx` | 组装 AppRuntime/SessionWorkspace/PermissionManager/MemoryManager/StatusService |
| 修改 | `src/tui/App.tsx` | 从直接 controller 驱动改为订阅 AppRuntime snapshot |
| 修改 | `src/tui/useChatController.ts` | 替换为更高层的 app runtime hook，或拆分为 input/runtime hooks |
| 修改 | `src/tui/components/InputPane.tsx` | Tab/Shift+Tab/Enter/Alt+Enter 仲裁、保留输入、autocomplete integration |
| 修改 | `src/tui/components/StatusBar.tsx` | 模式、估算 token、queue/paused、临时 review 状态 |
| 修改 | `src/tui/permissionPromptCoordinator.ts` | 与通用 InteractionCoordinator 对接或桥接 |
| 修改 | `src/session/ChatSessionController.ts` | 删除 slash parsing；增加 steer injection 和 active-run state 暴露；使用可热更新 permission snapshot |
| 修改 | `src/session/types.ts` | 扩展 transcript activity 或 app-level state types |
| 新建 | `tests/unit/commands/` | parser/registry/built-ins/dispatcher 单元测试 |
| 新建 | `tests/unit/app-runtime/` | AppEvent、SessionWorkspace、InteractionCoordinator、PermissionManager、QueueStore 测试 |
| 新建 | `tests/unit/review/` | Review target parse/freeze/result schema 测试 |
| 修改/新建 | `tests/unit/tui/` | InputPane/StatusBar/help/panel/command output 交互测试 |
| 修改 | `tests/unit/session/ChatSessionController.test.ts` | steer、安全边界、permission generation 相关测试 |
| 修改 | `tests/integration/bootstrapApp-resume.test.ts` | workspace/runtime 组装回归 |
| 新建 | `tests/integration/tui/command-framework.test.tsx` | slash flow、queue/steer/stop/review/clear/session E2E 样式测试 |

## 兼容性与迁移

- `ChatSessionController` 的现有对话行为保留，但 slash parsing 从 controller 移除，改为接收更纯净的普通 prompt 与运行中控制接口。
- task09 引入的 session archive/resume 机制继续复用；新增 session metadata、queue 和 lock 信息采用旁路 metadata/store 文件或扩展会话索引，不要求重写旧 JSONL 历史。缺失元数据时按 Spec 中明确默认值恢复。
- 现有 permission YAML 继续作为 project/global 存储格式；`PermissionManager` 封装原子写入与热重载，不更改文件语义。
- 自动笔记目录与索引格式不变；`MemoryManager` 只消费现有结构。
- MCP 继续由 `bootstrapApp` 初始化。首版 `/status` 只读汇总其 configured/connected/failed 状态，不改变初始化机制。
- `InputPane` 的空输入 Tab 切模式行为迁移到 Shift+Tab；Tab 改用于补全。需同步 helper 文案和可能存在的测试假设。
- 现有 `permissionPromptCoordinator` 可先作为 `InteractionCoordinator` 的一个专用 adapter；不必在第一步就重写其实现。
- `lastError` 仍保留给 Agent/provider；命令错误新增独立通道，避免破坏现有错误 UI 与测试预期。

## 验证策略

### 单元验证

- `CommandParser`
  - slash / non-slash / bare `/`
  - raw vs argv
  - quoted names、Windows paths、转义/未闭合引号
  - unknown command suggestion
- `CommandRegistry`
  - seal/lookup/alias
  - hidden/userInvocable
  - built-in conflict typed error
  - examples 反向验证 parser
- built-in handlers
  - `/clear`、`/plan`、`/do`、`/session`、`/memory`、`/permission`、`/review`、`/queue`、`/steer`、`/stop`
- `PermissionManager`
  - mode widening confirmation
  - generation increment
  - per-tool latest generation preflight
  - Plan/Review readonly cap override
- `MemoryManager`
  - list/show/delete
  - fingerprint mismatch / TOCTOU
  - atomic rewrite + unlink failure path
- `QueueStore`
  - add/list/run/remove/clear
  - persist-first accept
  - paused/drain semantics
  - restore after restart
- `ReviewRunner`
  - worktree/branch/GitHub PR target parse
  - repo mismatch / auth / network / not found / target changed
  - read-only tool registry enforcement
  - zero findings accepted
- `InteractionCoordinator`
  - one-shot settlement
  - session/mode/policy recheck
  - idempotency key dedupe

### 集成验证

- `bootstrapApp` 正确组装 AppRuntime、SessionWorkspace、PermissionManager、MemoryManager、StatusService、controller、permission prompt adapter。
- 运行中权限 mode/rule 改动对“已生成未执行”的下一次 tool preflight 立即生效。
- `/clear` 创建新 session，旧 session 通过 `/session` 恢复，Queue 与模式快照正确。
- `ReviewRunner` 将 findings 写回当前 session transcript/archive，但主 Provider context 不自动吸收 review result。

### 端到端验证

- TUI 中：
  - `/` autocomplete、Tab、Shift+Tab、`/help`
  - `/status` 运行中立即打开
  - Enter steer、Alt+Enter queue
  - `/stop` 后 queue paused，`/queue run` 恢复
  - `/review` 完成后回到原模式
  - `/clear "next"` 新建 session，`/session` 恢复旧 session 与 paused queue
- 重启恢复：queue 持久化并在恢复后保持 paused，不自动执行。
- 仅文档阶段：当前工作树对 `docs/task10` 以外无写入（本阶段文档生成时作为交付边界验证；实现阶段再扩展）。

## 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|------|------|------|------|
| AppRuntime/SessionWorkspace 改造过大，TUI 状态不一致 | slash 与普通消息路由错乱、session 切换闪烁 | 先引入 runtime 和 workspace 壳层，以适配器包裹现有 controller；typed AppEvent 回归测试覆盖命令、Agent Loop、modal 三路事件顺序 | 保留旧 `useChatController + controller` 路径作为临时 fallback，分阶段切换 |
| Steer 注入点处理不当 | guidance 丢失、乱序或污染 turn 计数 | 明确“下一安全模型边界”算法，unit 测试覆盖 streaming/tool/approval/retry/竞态；steer 事件独立持久化 | 先关闭 Enter steer，只保留显式 `/steer`，直到边界实现稳定 |
| Queue 持久化与自动 drain 竞争 | 重复执行、消息丢失、重启后状态错误 | persist-first + queue version + paused flag + idempotent scheduler；重启恢复测试 | 关闭自动 drain，仅保留手动 `/queue run` |
| Permission 热更新扩大当前 active run 边界 | 安全绕过 | generation + widening confirmation + per-tool latest-preflight；Plan/Review readonly cap 在 permission service 上层统一应用 | 暂时限制运行中只允许收紧权限，不允许升级 |
| Review worktree/PR target 不可重现 | 审错 diff、结果不稳定 | 冻结 repo identity/base/head/diff hash；GitHub PR 仅支持 GitHub 且校验 canonical repo；target_changed 失败 | 首版先仅支持 worktree/branch，暂不开放 PR |
| Session lock 跨平台实现不一致 | 并发写损坏 session | 以 lock file + PID + 启动标识为最低契约；无法验证 stale 时拒绝自动清理 | 在不可靠平台上退化为“拒绝恢复已加锁 session”，不自动回收 |
| Memory delete / permission remove 与 modal 竞态 | 错删文件或规则 | fingerprint/generation/version 再校验 + idempotency key | 先在相应命令上禁用运行中执行，只允许 idle 时执行 |
| 现有 permission prompt coordinator 与统一交互协调器冲突 | modal 状态错乱 | 把现有 coordinator 作为专用 adapter 挂到 InteractionCoordinator，保持现有 tool approval 契约 | 暂不统一 tool approval，只统一 command interactions |
| `/help`、补全、usage 漂移 | 文档与行为不一致 | 所有 built-in examples 通过 parser 自动验证；registry sealed snapshot 单源输出 | 临时禁用详情页中的 examples 自动渲染，只保留 usage |
