# 斜杠命令框架与运行时控制 Tasks

## 绑定输入

- spec.md: `034bb429762af17fc2c4890f851c9721c6ef13a2`（reviewed-unapproved）
- plan.md: `ba7d895a5d725a5ed423fe7057d0c0bb99aa6fb5`（draft / self-reviewed；正式 3-reviewer 门禁待确认）

## 文件清单

| 操作 | 路径 | 任务 |
|------|------|------|
| 新建 | `src/commands/types.ts` | T1 |
| 新建 | `src/commands/errors.ts` | T1 |
| 新建 | `src/commands/parser.ts` | T1 |
| 新建 | `src/commands/registry.ts` | T1 |
| 新建 | `tests/unit/commands/parser.test.ts` | T1 |
| 新建 | `tests/unit/commands/registry.test.ts` | T1 |
| 新建 | `src/app/runtime/types.ts` | T2 |
| 新建 | `src/app/runtime/AppRuntime.ts` | T2 |
| 新建 | `tests/unit/app-runtime/AppRuntime.test.ts` | T2 |
| 新建 | `src/app/session/SessionQueueStore.ts` | T3 |
| 新建 | `src/app/session/sessionLock.ts` | T3 |
| 新建 | `tests/unit/app-runtime/SessionQueueStore.test.ts` | T3 |
| 新建 | `tests/unit/app-runtime/sessionLock.test.ts` | T3 |
| 新建 | `src/app/session/SessionWorkspace.ts` | T4 |
| 新建 | `tests/unit/app-runtime/SessionWorkspace.test.ts` | T4 |
| 新建 | `src/app/permissions/PermissionManager.ts` | T5 |
| 新建 | `tests/unit/app-runtime/PermissionManager.test.ts` | T5 |
| 新建 | `src/app/memory/MemoryManager.ts` | T6 |
| 新建 | `tests/unit/app-runtime/MemoryManager.test.ts` | T6 |
| 新建 | `src/app/interaction/InteractionCoordinator.ts` | T7 |
| 新建 | `tests/unit/app-runtime/InteractionCoordinator.test.ts` | T7 |
| 新建 | `src/app/status/StatusService.ts` | T8 |
| 新建 | `tests/unit/app-runtime/StatusService.test.ts` | T8 |
| 新建 | `src/app/review/ReviewRunner.ts` | T9 |
| 新建 | `src/app/review/targetFreeze.ts` | T9 |
| 新建 | `tests/unit/review/ReviewRunner.test.ts` | T9 |
| 新建 | `tests/unit/review/targetFreeze.test.ts` | T9 |
| 新建 | `src/commands/dispatcher.ts` | T10 |
| 新建 | `src/commands/context.ts` | T10 |
| 新建 | `tests/unit/commands/dispatcher.test.ts` | T10 |
| 新建 | `src/commands/builtins/` | T11 |
| 新建 | `tests/unit/commands/builtins.test.ts` | T11 |
| 新建 | `src/app/runtime/InputRouter.ts` | T12 |
| 新建 | `tests/unit/app-runtime/InputRouter.test.ts` | T12 |
| 修改 | `src/session/ChatSessionController.ts` | T13 |
| 修改 | `src/session/types.ts` | T13 |
| 修改 | `tests/unit/session/ChatSessionController.test.ts` | T13 |
| 修改 | `src/agent/AgentLoop.ts` | T14 |
| 修改 | `src/agent/types.ts` | T14 |
| 修改 | `tests/unit/agent/AgentLoop.test.ts` | T14 |
| 修改 | `src/tui/App.tsx` | T15 |
| 修改 | `src/tui/useChatController.ts` | T15 |
| 修改 | `src/tui/components/InputPane.tsx` | T15 |
| 修改 | `src/tui/components/StatusBar.tsx` | T15 |
| 新建 | `src/tui/components/CommandHelpPanel.tsx` | T15 |
| 新建 | `src/tui/components/StatusPanel.tsx` | T15 |
| 新建 | `src/tui/components/CommandOutput.tsx` | T15 |
| 新建 | `tests/unit/tui/commandInput.test.tsx` | T15 |
| 修改 | `src/app/bootstrapApp.tsx` | T16 |
| 修改 | `src/cli/main.ts` | T16 |
| 修改 | `tests/integration/bootstrapApp-resume.test.ts` | T16 |
| 新建 | `tests/integration/tui/command-framework.test.tsx` | T17 |
| 修改 | `tests/e2e/tmux/agentcode-smoke.sh` 或新增 e2e 脚本 | T17 |

## T1: CommandParser + CommandRegistry 核心

**目标：** 建立纯函数命令解析器与可 seal 的注册中心；覆盖 raw/argv 固定转义规则、alias、hidden/userInvocable、built-in 冲突 typed error。

**文件：**
- `src/commands/types.ts`
- `src/commands/errors.ts`
- `src/commands/parser.ts`
- `src/commands/registry.ts`
- `tests/unit/commands/parser.test.ts`
- `tests/unit/commands/registry.test.ts`

**依赖：** 无

**测试先行：**

1. 添加 parser 测试：空输入、`/`、大小写、rawArguments、quoted argv、Windows 路径、未闭合引号、未知命令候选。
2. 添加 registry 测试：registerBatch/seal、alias 查找、hidden 不出现在 listVisible、canonical/alias 冲突 fatal。
3. 运行 `npm test -- tests/unit/commands/parser.test.ts tests/unit/commands/registry.test.ts`，预期因模块不存在失败。
4. 实现最小 parser/registry。
5. 重跑测试与 `npm run typecheck`，预期通过。

**回归验证：** `npm test -- tests/unit/commands/`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T2: AppRuntime 事件总线与统一快照

**目标：** 引入 typed `AppEvent` 与 `AppSnapshot`，使命令动作、Agent Loop 事件、modal 结果进入单一顺序归并点；React 只订阅快照。

**文件：**
- `src/app/runtime/types.ts`
- `src/app/runtime/AppRuntime.ts`
- `tests/unit/app-runtime/AppRuntime.test.ts`

**依赖：** T1（共用 command/app 类型边界，可先依赖最小 types）

**测试先行：**

1. 测试顺序 dispatch：notice → panel → mode.changed → session.activated 后 snapshot 一致。
2. 测试 command error 与 agent lastError 独立通道。
3. 运行测试，预期失败。
4. 实现 runtime store/subscribe/dispatch。
5. 重跑测试，预期通过。

**回归验证：** `npm test -- tests/unit/app-runtime/AppRuntime.test.ts && npm run typecheck`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T3: SessionQueueStore + session lock

**目标：** 实现 session-scoped 持久 Queue 与跨进程独占写锁；所有 add 先持久化再接受；重启恢复后 paused 且不自动 drain。

**文件：**
- `src/app/session/SessionQueueStore.ts`
- `src/app/session/sessionLock.ts`
- `tests/unit/app-runtime/SessionQueueStore.test.ts`
- `tests/unit/app-runtime/sessionLock.test.ts`

**依赖：** 无（可与 T1/T2 并行）

**测试先行：**

1. Queue：add/list/remove/clear、persist-first、paused/run、FIFO、冻结 Agent mode、恢复后不自动执行。
2. Lock：acquire/release、同 session no-op 语义、有效锁拒绝、stale 仅在 PID/启动标识不匹配时清理。
3. 实现并验证。

**回归验证：** `npm test -- tests/unit/app-runtime/SessionQueueStore.test.ts tests/unit/app-runtime/sessionLock.test.ts`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T4: SessionWorkspace 生命周期

**目标：** 管理活动 controller 创建/恢复/重命名/替换；`/clear` 与 `/session resume` 通过候选 controller 原子激活；集成 Queue 与 lock。

**文件：**
- `src/app/session/SessionWorkspace.ts`
- `tests/unit/app-runtime/SessionWorkspace.test.ts`

**依赖：** T2、T3；复用现有 `SessionArchive` / `SessionRestore`

**测试先行：**

1. createSession：Default agent mode、沿用 selected permission、空 queue。
2. resumeSession：ID/名称匹配规则、歧义失败、损坏失败、锁占用失败。
3. 候选构造失败时活动 session 不变。
4. rename 只改 metadata。

**回归验证：** `npm test -- tests/unit/app-runtime/SessionWorkspace.test.ts && npm test -- tests/unit/session/`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T5: PermissionManager 热更新

**目标：** 封装 permission snapshot、selected/effective mode、generation、rules 视图、atomic 写入/重载、升级确认语义。

**文件：**
- `src/app/permissions/PermissionManager.ts`
- `tests/unit/app-runtime/PermissionManager.test.ts`

**依赖：** 现有 `src/tools/permissions/*`

**测试先行：**

1. Plan/Review 下 effective=readonly，selected 可记录 yolo。
2. 扩大权限需确认；收紧可立即执行。
3. generation 递增；每个尚未开始 tool call 用最新 generation 重新 preflight。
4. remove rule 原子写失败时旧规则保留。

**回归验证：** `npm test -- tests/unit/app-runtime/PermissionManager.test.ts tests/unit/tools/permissions/`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T6: MemoryManager 查看与删除

**目标：** 提供 USER/PROJECT 索引列表、show、delete；delete 经 fingerprint 校验后物理删除正文并更新索引。

**文件：**
- `src/app/memory/MemoryManager.ts`
- `tests/unit/app-runtime/MemoryManager.test.ts`

**依赖：** 现有 memory 路径与索引格式

**测试先行：**

1. list/show 正确。
2. delete 成功后索引与正文消失。
3. 目标变化/越界/确认取消不删文件。

**回归验证：** `npm test -- tests/unit/app-runtime/MemoryManager.test.ts tests/unit/notes/AutoNoteWriter.test.ts`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T7: InteractionCoordinator 多步交互

**目标：** 统一 picker/confirm 请求生命周期、二次校验、idempotency key；桥接现有 tool permission prompt。

**文件：**
- `src/app/interaction/InteractionCoordinator.ts`
- `tests/unit/app-runtime/InteractionCoordinator.test.ts`

**依赖：** T2

**测试先行：**

1. request 只结算一次。
2. session 切换、mode/policy 变化、fingerprint 变化拒绝。
3. 重复 idempotency key 不重复副作用。
4. tool-approval adapter 保持旧语义。

**回归验证：** `npm test -- tests/unit/app-runtime/InteractionCoordinator.test.ts tests/unit/tui/PermissionPromptCoordinator.test.ts`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T8: StatusService

**目标：** 聚合状态栏与 `/status` 面板数据；慢探针有超时，不发模型请求。

**文件：**
- `src/app/status/StatusService.ts`
- `tests/unit/app-runtime/StatusService.test.ts`

**依赖：** T2、T4、T5、T6

**测试先行：**

1. 状态栏字段：mode/status/model/estimated tokens/queue/paused/review。
2. 详细 panel 分区齐全。
3. Git/MCP 超时只标 unknown。

**回归验证：** `npm test -- tests/unit/app-runtime/StatusService.test.ts`

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T9: ReviewRunner 隔离只读审查

**目标：** 冻结 worktree/branch/GitHub PR 目标，运行只读隔离 review，输出结构化 findings；默认不进入主 Provider context。

**文件：**
- `src/app/review/targetFreeze.ts`
- `src/app/review/ReviewRunner.ts`
- `tests/unit/review/targetFreeze.test.ts`
- `tests/unit/review/ReviewRunner.test.ts`

**依赖：** T2

**测试先行：**

1. worktree/branch/PR 解析与冻结。
2. auth/network/not_found/repo_mismatch/target_changed 分类。
3. 写工具不可用。
4. 零 findings 成功。
5. 结果写 review activity，不进入主 provider context。

**回归验证：** `npm test -- tests/unit/review/`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T10: CommandDispatcher + CommandContext

**目标：** 实现 preflight/commit 两阶段分发；命令 handler 只读 snapshot 返回 actions；operation 级 active-run policy 与模式上限生效。

**文件：**
- `src/commands/context.ts`
- `src/commands/dispatcher.ts`
- `tests/unit/commands/dispatcher.test.ts`

**依赖：** T1、T2、T4、T5、T6、T7、T8、T9

**测试先行：**

1. preflight 失败零提交。
2. Plan/Review operation 矩阵。
3. 确认后二次策略校验。
4. 多动作顺序提交与部分失败停止。

**回归验证：** `npm test -- tests/unit/commands/dispatcher.test.ts`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T11: 13 个 built-in 命令 handlers

**目标：** 实现 `/help` `/compact` `/clear` `/plan` `/do` `/session` `/memory` `/permission` `/status` `/review` `/stop` `/steer` `/queue` 及 aliases；examples 反向通过 parser。

**文件：**
- `src/commands/builtins/*.ts`
- `src/commands/builtins/index.ts`
- `tests/unit/commands/builtins.test.ts`

**依赖：** T10

**测试先行：**

1. 每个命令的参数 grammar 与 usage 错误。
2. 无参数/有参数 plan/do。
3. queue add/list/run/remove/clear。
4. session/memory/permission 管理路径。
5. aliases 规范化。

**回归验证：** `npm test -- tests/unit/commands/`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T12: InputRouter 与键位仲裁

**目标：** 把 Enter/Alt+Enter/Tab/Shift+Tab 与 slash/普通消息路由集中到 App 层；接受后清空，失败保留。

**文件：**
- `src/app/runtime/InputRouter.ts`
- `tests/unit/app-runtime/InputRouter.test.ts`

**依赖：** T10、T11、T4

**测试先行：**

1. slash → command。
2. idle 普通 Enter → submitPrompt。
3. active Enter → steer。
4. active Alt+Enter → queue add。
5. `/` Enter 不消费。
6. 失败不消费。

**回归验证：** `npm test -- tests/unit/app-runtime/InputRouter.test.ts`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T13: ChatSessionController 去 slash，暴露运行中控制接口

**目标：** 删除 controller 内 `parseCommand`；改为接收普通 prompt、steer guidance、stop/cancel、permission snapshot generation；保留完整 turn 生命周期。

**文件：**
- `src/session/ChatSessionController.ts`
- `src/session/types.ts`
- `tests/unit/session/ChatSessionController.test.ts`

**依赖：** T5、T12

**测试先行：**

1. 普通 prompt 不再识别 `/compact`。
2. steer 不增 turnIndex，进入 archive。
3. stop 标记 stopped 并 expire pending approvals。
4. permission generation 变化后下一次 tool preflight 用新快照。

**回归验证：** `npm test -- tests/unit/session/ChatSessionController.test.ts`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T14: AgentLoop 安全边界注入 Steer

**目标：** 在下一安全模型调用边界消费 steer guidance；不中断当前 stream/tool；支持取消。

**文件：**
- `src/agent/AgentLoop.ts`
- `src/agent/types.ts`
- `tests/unit/agent/AgentLoop.test.ts`

**依赖：** T13

**测试先行：**

1. streaming 中 enqueue steer，下一 iteration 前注入。
2. tool running 中不取消工具。
3. awaiting permission 时 steer 不替代审批。
4. cancelled 路径正确。

**回归验证：** `npm test -- tests/unit/agent/`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T15: TUI 接入补全、帮助、状态栏、命令输出与 modal

**目标：** InputPane/App/StatusBar 订阅 AppRuntime；实现补全、help panel、status panel、command output、Shift+Tab 切模式、运行中可输入。

**文件：**
- `src/tui/App.tsx`
- `src/tui/useChatController.ts`（或替换为 `useAppRuntime`）
- `src/tui/components/InputPane.tsx`
- `src/tui/components/StatusBar.tsx`
- `src/tui/components/CommandHelpPanel.tsx`
- `src/tui/components/StatusPanel.tsx`
- `src/tui/components/CommandOutput.tsx`
- `tests/unit/tui/commandInput.test.tsx`

**依赖：** T8、T12、T13、T7

**测试先行：**

1. 运行中输入不被 disabled。
2. Tab 补全不执行；Shift+Tab 切模式。
3. `/help` `/status` 打开 panel。
4. command error 不覆盖 agent error。

**回归验证：** `npm test -- tests/unit/tui/ && npm run typecheck`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T16: bootstrapApp / CLI 组装

**目标：** 组装 registry、runtime、workspace、managers、review runner、input router；启动时 seal registry 并处理冲突 fatal；resume 走 SessionWorkspace。

**文件：**
- `src/app/bootstrapApp.tsx`
- `src/cli/main.ts`
- `tests/integration/bootstrapApp-resume.test.ts`

**依赖：** T4–T15

**测试先行：**

1. 无 resume 正常启动。
2. resume 恢复 session metadata/queue paused。
3. registry 冲突在 render 前 fatal。
4. 旧 bootstrap 回归不破坏。

**回归验证：** `npm test -- tests/integration/ && npm run typecheck`

**任务后审查：** 高风险，3 个只读 reviewer。

---

## T17: 集成与 E2E 验收

**目标：** 覆盖 AC19/AC20 主路径：steer/queue/stop/status/review/clear/session restore/queue restart。

**文件：**
- `tests/integration/tui/command-framework.test.tsx`
- E2E 脚本更新或新增

**依赖：** T16

**测试先行：**

1. 集成测试模拟 active run + Enter/Alt+Enter/`/stop`/`/queue run`。
2. review 结果隔离。
3. clear + resume + paused queue。
4. 重启恢复 queue 不自动 drain。
5. 若环境允许，运行 `npm run e2e:tmux`。

**回归验证：**
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run e2e:tmux`（不可用则记录环境阻塞）

**任务后审查：** 高风险，3 个只读 reviewer。

---

## 执行顺序

```text
T1 ─┐
T2 ─┼─> T10 ─> T11 ─> T12 ─┐
T3 ─┤                       │
T4 <┘                       ├─> T13 ─> T14 ─> T15 ─> T16 ─> T17
T5 ─┐                       │
T6 ─┼─> T8 ─────────────────┘
T7 ─┘
T9 ─────────────────────────> T10
```

简化表达：

```text
[T1, T2, T3, T5, T6, T7, T9] 可先并行
T4 依赖 T2+T3
T8 依赖 T2+T4+T5+T6
T10 依赖 T1+T2+T4+T5+T6+T7+T8+T9
T11 依赖 T10
T12 依赖 T10+T11+T4
T13 依赖 T5+T12
T14 依赖 T13
T15 依赖 T7+T8+T12+T13
T16 依赖 T4..T15
T17 依赖 T16
```

## 任务证据与 must_fix 追踪

来自 spec 评审的 must_fix / suggestions，在实现阶段必须有对应证据：

| 来源 | 项 | 落地任务 |
|------|----|----------|
| Spec R1 | Plan/Review 数据面只读 vs 控制面写 | T10/T11/T13 |
| Spec R1 | active run 权限 generation preflight | T5/T13/T14 |
| Spec R1 | Queue persist-first + restart | T3/T4/T17 |
| Spec R1 | Review 结果默认不进主 context | T9/T15 |
| Spec R1 | PR/worktree 冻结 | T9 |
| Spec R1 | operation 矩阵与确认后再校验 | T7/T10 |
| Spec R1 | argv/clear/session/lock/stop/idempotency | T1/T3/T4/T7/T12 |
| Spec R1 suggestions | worktree target_changed 语义 | T9 |
| Spec R1 suggestions | permission upgrade 比较基准 UX | T5/T11/T15 |
| Plan suggestions | idle 模式下 clear/resume/queue run 规则 | T10/T11 |
