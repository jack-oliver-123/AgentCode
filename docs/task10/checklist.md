# 斜杠命令框架与运行时控制 Checklist

## 绑定输入

- spec.md: `034bb429762af17fc2c4890f851c9721c6ef13a2`（reviewed-unapproved）
- plan.md: `ba7d895a5d725a5ed423fe7057d0c0bb99aa6fb5`（draft / self-reviewed）
- tasks.md: `5dbd3bcfe9fa7a53cacfcc0b30c803094340ee6c`（draft / self-reviewed）

## 本次实现验证

- 实现范围：`package.json`、`src/`、`tests/`
- 变更集基线：`6568bdac6e77239424f957ec1647d2880697ee84`
- 变更集 hash：`8ae0fd7571cb3d7fdff85b03feeaed0e1cb65465b122615fe23733bcd1e7a6f3`
- 验证环境：Windows、PowerShell、Node.js；真实 TUI E2E 由 Git Bash + psmux/tmux 驱动

## 需求行为

- [x] AC1（对应 F1）：命令解析契约（验证：`npm test -- tests/unit/commands/parser.test.ts`；预期：空输入、单独 `/` Enter 不消费、大小写、raw/argv、Windows 路径、未闭合引号、未知命令候选、前缀不执行均通过）
- [x] AC2（对应 F2）：注册与冲突（验证：`npm test -- tests/unit/commands/registry.test.ts`；预期：13 built-in seal 成功；canonical/alias 冲突 typed fatal；hidden/userInvocable 行为正确）
- [x] AC3（对应 F3）：纯 handler 与 preflight（验证：`npm test -- tests/unit/commands/dispatcher.test.ts tests/unit/app-runtime/AppRuntime.test.ts`；预期：preflight 失败零提交；command error 与 agent lastError 独立；AppEvent 顺序一致）
- [x] AC4（对应 F4+F5）：发现/补全/帮助/aliases（验证：`npm test -- tests/unit/tui/commandInput.test.tsx tests/unit/commands/builtins.test.ts`；预期：13 命令与 aliases 可见；Tab 只补全；Shift+Tab 切模式；`/help` 与 `/help review` 显示元数据）
- [x] AC5（对应 F6）：Agent 模式与 Plan 只读（验证：`npm test -- tests/unit/commands/builtins.test.ts tests/unit/app-runtime/PermissionManager.test.ts`；预期：`/plan`/`/do` 无参数不调用 Provider；Plan 中 yolo 仍 readonly；Review 结束后恢复原模式）
- [x] AC6（对应 F7+F8）：运行中矩阵与呈现（验证：`npm test -- tests/unit/commands/dispatcher.test.ts tests/unit/app-runtime/InteractionCoordinator.test.ts`；预期：operation 矩阵正确；确认后二次校验；控制面写有 audit；Review result 默认不进主 Provider context）
- [x] AC7（对应 F9）：`/compact`（验证：`npm test -- tests/unit/commands/builtins.test.ts tests/unit/context/contextManager.test.ts`；预期：无参数默认摘要；有 instructions 仅本次生效；四条结果路径正确；运行中拒绝）
- [x] AC8（对应 F10+F11）：clear/session（验证：`npm test -- tests/unit/app-runtime/SessionWorkspace.test.ts tests/unit/app-runtime/sessionLock.test.ts`；预期：命名新 session、锁、恢复匹配、歧义/占用失败、同 session no-op）
- [x] AC9（对应 F12）：memory 查看/删除（验证：`npm test -- tests/unit/app-runtime/MemoryManager.test.ts`；预期：status/show 正确；delete 物理删除；TOCTOU/取消/越界安全）
- [x] AC10（对应 F13）：permission 热更新（验证：`npm test -- tests/unit/app-runtime/PermissionManager.test.ts tests/unit/session/ChatSessionController.test.ts`；预期：扩大权限确认；generation preflight；已开始工具不追溯）
- [x] AC11（对应 F14）：status 与状态栏（验证：`npm test -- tests/unit/app-runtime/StatusService.test.ts tests/unit/tui/commandInput.test.tsx`；预期：模式/token/queue/paused/review 正确；`/status` 运行中不调 Provider；超时 unknown）
- [x] AC12（对应 F15）：ReviewRunner（验证：`npm test -- tests/unit/review/`；预期：worktree/branch/PR 冻结；错误分类；只读；零 findings 成功；结果隔离）
- [x] AC13（对应 F16）：Steer（验证：`npm test -- tests/unit/agent/AgentLoop.test.ts tests/unit/app-runtime/InputRouter.test.ts`；预期：下一安全边界注入；空闲拒绝；竞态不转 queue；审批不绕过）
- [x] AC14（对应 F17）：Queue（验证：`npm test -- tests/unit/app-runtime/SessionQueueStore.test.ts tests/unit/app-runtime/InputRouter.test.ts`；预期：persist-first；FIFO drain；paused；切 session 不迁移）
- [x] AC15（对应 F18）：Stop（验证：`npm test -- tests/unit/session/ChatSessionController.test.ts tests/unit/app-runtime/InputRouter.test.ts`；预期：取消模型/工具；pending approval expired；queue paused）
- [x] AC16（对应 F19）：交互结算（验证：`npm test -- tests/unit/app-runtime/InteractionCoordinator.test.ts`；预期：单次结算、过期拒绝、idempotency 去重）
- [x] AC17（对应 N1+N5+N9）：纯测试与单源元数据（验证：`npm test -- tests/unit/commands/`；预期：不依赖真实 Provider/Ink；examples 通过 parser）
- [x] AC18（对应 N2+N3+N4+N8）：安全与并发（验证：相关 unit/integration 套件；预期：local 不泄露、Plan/Review 只读、session lock、memory/permission TOCTOU、Windows/POSIX 路径/锁覆盖或记录平台证据）
- [x] AC19（端到端）：真实 TUI 主路径（验证：`npm run e2e:tmux` 或等价集成；预期：Steer/Queue/Status/Stop/Queue run/Review/Clear/Session restore 全通过；psmux/tmux 不可用时记录环境阻塞）
- [x] AC20（重启恢复）：Queue 持久化（验证：集成测试或手动重启；预期：恢复后 queue 内容/顺序/Agent mode/paused 保持，且自动不执行）
- [x] AC21（文档阶段边界）：仅四份文档（验证：`git status --short`；预期：实现阶段前 diff 仅 `docs/task10/{spec,plan,tasks,checklist}.md`）

## 集成与回归

- [x] 现有 session archive/resume 不回归（验证：`npm test -- tests/unit/session/ tests/integration/bootstrapApp-resume.test.ts`）
- [x] 现有权限系统不回归（验证：`npm test -- tests/unit/tools/permissions/`）
- [x] 现有 Agent Loop 不回归（验证：`npm test -- tests/unit/agent/`）
- [x] 现有 TUI 权限弹窗不回归（验证：`npm test -- tests/unit/tui/PermissionPrompt*.test.*`）
- [x] bootstrap 组装成功（验证：`npm test -- tests/integration/`）

## 构建与测试

- [x] 全量测试通过（验证：`npm test`；结果：77 个测试文件，857 passed，3 skipped）
- [x] 类型检查通过（验证：`npm run typecheck`）
- [x] Lint 通过（验证：`npm run lint`；结果：检查 210 个文件）
- [x] 构建通过（验证：`npm run build`）

## 安全、权限与回滚

- [x] Plan/Review Agent 数据面只读不可被 yolo/auto/Steer 绕过（验证：T5/T9/T10/T13 相关测试）
- [x] 用户显式控制面写仅限白名单并写 audit（验证：T6/T7/T10/T11）
- [x] session 写锁防并发写（验证：`sessionLock` 测试）
- [x] memory/permission TOCTOU 防护（验证：MemoryManager/PermissionManager/InteractionCoordinator 测试）
- [x] 回滚可执行（回滚锚点：`6568bda`；实现前基线全量测试为 58 个文件、726 passed、3 skipped；为保留待验收实现，未执行破坏性回滚）

## 端到端

- [x] 运行中：`Enter` steer、`Alt+Enter` queue、`/status` 即时打开
- [x] `/stop` 后 queue paused，`/queue run` 恢复
- [x] `/review` 得到只读结构化结果并恢复原模式
- [x] `/clear "next"` 新建 session，`/session` 恢复旧 session 与 paused queue
- [x] 重启后 queue 不自动 drain

## 验收记录

| 条目 | 当前变更集 hash | 实际结果 | 证据 | 状态 |
|------|-----------------|----------|------|------|
| AC1 parser | `8ae0fd75` | 契约覆盖通过 | `parser.test.ts` | 通过 |
| AC2 registry | `8ae0fd75` | 13 个 built-in、alias 与 seal 通过 | `registry.test.ts`、`builtins.test.ts` | 通过 |
| AC3 dispatcher/runtime | `8ae0fd75` | 两阶段 preflight/commit 与事件顺序通过 | `dispatcher.test.ts`、`AppRuntime.test.ts` | 通过 |
| AC4 help/completion | `8ae0fd75` | 帮助、alias、Tab 补全与模式切换通过 | `commandInput.test.tsx`、真实 TUI E2E | 通过 |
| AC5 mode | `8ae0fd75` | Default/Plan/YOLO 及 Review 模式恢复通过 | built-in、permission、review 测试 | 通过 |
| AC6 runtime matrix | `8ae0fd75` | operation 矩阵、确认重校验、audit 通过 | dispatcher、interaction、TUI 集成测试 | 通过 |
| AC7 compact | `8ae0fd75` | 摘要与单次 instructions 路径通过 | built-in、ContextManager 测试 | 通过 |
| AC8 session | `8ae0fd75` | create/resume/锁/匹配行为通过 | SessionWorkspace、sessionLock 测试 | 通过 |
| AC9 memory | `8ae0fd75` | status/show/delete 与越界防护通过 | `MemoryManager.test.ts` | 通过 |
| AC10 permission | `8ae0fd75` | 热更新、持久化、generation 与并发串行化通过 | PermissionManager、controller 测试 | 通过 |
| AC11 status | `8ae0fd75` | 即时状态与超时降级通过 | StatusService、TUI 测试 | 通过 |
| AC12 review | `8ae0fd75` | 目标冻结、只读工具、结构化隔离结果通过 | ReviewRunner、targetFreeze、真实 TUI E2E | 通过 |
| AC13 steer | `8ae0fd75` | 安全边界注入及 Review guidance 通道通过 | AgentLoop、InputRouter、runtime 测试 | 通过 |
| AC14 queue | `8ae0fd75` | persist-first、FIFO、暂停与隔离通过 | QueueStore、InputRouter、runtime 测试 | 通过 |
| AC15 stop | `8ae0fd75` | 取消、审批过期及 Queue 暂停通过 | controller、InputRouter、真实 TUI E2E | 通过 |
| AC16 interaction | `8ae0fd75` | 单次结算、过期与幂等通过 | `InteractionCoordinator.test.ts` | 通过 |
| AC17 pure tests | `8ae0fd75` | 命令纯测试与 examples 解析通过 | `tests/unit/commands/` | 通过 |
| AC18 security | `8ae0fd75` | 只读、锁、TOCTOU 与 Windows 路径覆盖通过 | unit/integration 全量门禁 | 通过 |
| AC19 e2e | `8ae0fd75` | 标准命令退出码 0 | `npm run e2e:tmux`：`tmux E2E smoke passed` | 通过 |
| AC20 restart queue | `8ae0fd75` | paused Queue、顺序、模式恢复且不自动 drain | bootstrap/runtime 集成测试与真实 TUI E2E | 通过 |
| AC21 docs-only phase | `8ae0fd75` | 文档阶段与实现阶段边界可追溯 | 文档提交 `6568bda`；实现经用户明确授权后开始 | 通过 |
| 全量测试 | `8ae0fd75` | 857 passed，3 skipped | `npm test`（77 个测试文件） | 通过 |
| typecheck/lint/build | `8ae0fd75` | 三项均退出码 0 | `npm run typecheck`、`npm run lint`、`npm run build` | 通过 |
