# 斜杠命令框架与运行时控制 Checklist

## 绑定输入

- spec.md: `034bb429762af17fc2c4890f851c9721c6ef13a2`（reviewed-unapproved）
- plan.md: `ba7d895a5d725a5ed423fe7057d0c0bb99aa6fb5`（draft / self-reviewed）
- tasks.md: `5dbd3bcfe9fa7a53cacfcc0b30c803094340ee6c`（draft / self-reviewed）

## 需求行为

- [ ] AC1（对应 F1）：命令解析契约（验证：`npm test -- tests/unit/commands/parser.test.ts`；预期：空输入、单独 `/` Enter 不消费、大小写、raw/argv、Windows 路径、未闭合引号、未知命令候选、前缀不执行均通过）
- [ ] AC2（对应 F2）：注册与冲突（验证：`npm test -- tests/unit/commands/registry.test.ts`；预期：13 built-in seal 成功；canonical/alias 冲突 typed fatal；hidden/userInvocable 行为正确）
- [ ] AC3（对应 F3）：纯 handler 与 preflight（验证：`npm test -- tests/unit/commands/dispatcher.test.ts tests/unit/app-runtime/AppRuntime.test.ts`；预期：preflight 失败零提交；command error 与 agent lastError 独立；AppEvent 顺序一致）
- [ ] AC4（对应 F4+F5）：发现/补全/帮助/aliases（验证：`npm test -- tests/unit/tui/commandInput.test.tsx tests/unit/commands/builtins.test.ts`；预期：13 命令与 aliases 可见；Tab 只补全；Shift+Tab 切模式；`/help` 与 `/help review` 显示元数据）
- [ ] AC5（对应 F6）：Agent 模式与 Plan 只读（验证：`npm test -- tests/unit/commands/builtins.test.ts tests/unit/app-runtime/PermissionManager.test.ts`；预期：`/plan`/`/do` 无参数不调用 Provider；Plan 中 yolo 仍 readonly；Review 结束后恢复原模式）
- [ ] AC6（对应 F7+F8）：运行中矩阵与呈现（验证：`npm test -- tests/unit/commands/dispatcher.test.ts tests/unit/app-runtime/InteractionCoordinator.test.ts`；预期：operation 矩阵正确；确认后二次校验；控制面写有 audit；Review result 默认不进主 Provider context）
- [ ] AC7（对应 F9）：`/compact`（验证：`npm test -- tests/unit/commands/builtins.test.ts tests/unit/context/contextManager.test.ts`；预期：无参数默认摘要；有 instructions 仅本次生效；四条结果路径正确；运行中拒绝）
- [ ] AC8（对应 F10+F11）：clear/session（验证：`npm test -- tests/unit/app-runtime/SessionWorkspace.test.ts tests/unit/app-runtime/sessionLock.test.ts`；预期：命名新 session、锁、恢复匹配、歧义/占用失败、同 session no-op）
- [ ] AC9（对应 F12）：memory 查看/删除（验证：`npm test -- tests/unit/app-runtime/MemoryManager.test.ts`；预期：status/show 正确；delete 物理删除；TOCTOU/取消/越界安全）
- [ ] AC10（对应 F13）：permission 热更新（验证：`npm test -- tests/unit/app-runtime/PermissionManager.test.ts tests/unit/session/ChatSessionController.test.ts`；预期：扩大权限确认；generation preflight；已开始工具不追溯）
- [ ] AC11（对应 F14）：status 与状态栏（验证：`npm test -- tests/unit/app-runtime/StatusService.test.ts tests/unit/tui/commandInput.test.tsx`；预期：模式/token/queue/paused/review 正确；`/status` 运行中不调 Provider；超时 unknown）
- [ ] AC12（对应 F15）：ReviewRunner（验证：`npm test -- tests/unit/review/`；预期：worktree/branch/PR 冻结；错误分类；只读；零 findings 成功；结果隔离）
- [ ] AC13（对应 F16）：Steer（验证：`npm test -- tests/unit/agent/AgentLoop.test.ts tests/unit/app-runtime/InputRouter.test.ts`；预期：下一安全边界注入；空闲拒绝；竞态不转 queue；审批不绕过）
- [ ] AC14（对应 F17）：Queue（验证：`npm test -- tests/unit/app-runtime/SessionQueueStore.test.ts tests/unit/app-runtime/InputRouter.test.ts`；预期：persist-first；FIFO drain；paused；切 session 不迁移）
- [ ] AC15（对应 F18）：Stop（验证：`npm test -- tests/unit/session/ChatSessionController.test.ts tests/unit/app-runtime/InputRouter.test.ts`；预期：取消模型/工具；pending approval expired；queue paused）
- [ ] AC16（对应 F19）：交互结算（验证：`npm test -- tests/unit/app-runtime/InteractionCoordinator.test.ts`；预期：单次结算、过期拒绝、idempotency 去重）
- [ ] AC17（对应 N1+N5+N9）：纯测试与单源元数据（验证：`npm test -- tests/unit/commands/`；预期：不依赖真实 Provider/Ink；examples 通过 parser）
- [ ] AC18（对应 N2+N3+N4+N8）：安全与并发（验证：相关 unit/integration 套件；预期：local 不泄露、Plan/Review 只读、session lock、memory/permission TOCTOU、Windows/POSIX 路径/锁覆盖或记录平台证据）
- [ ] AC19（端到端）：真实 TUI 主路径（验证：`npm run e2e:tmux` 或等价集成；预期：Steer/Queue/Status/Stop/Queue run/Review/Clear/Session restore 全通过；psmux/tmux 不可用时记录环境阻塞）
- [ ] AC20（重启恢复）：Queue 持久化（验证：集成测试或手动重启；预期：恢复后 queue 内容/顺序/Agent mode/paused 保持，且自动不执行）
- [ ] AC21（文档阶段边界）：仅四份文档（验证：`git status --short`；预期：实现阶段前 diff 仅 `docs/task10/{spec,plan,tasks,checklist}.md`）

## 集成与回归

- [ ] 现有 session archive/resume 不回归（验证：`npm test -- tests/unit/session/ tests/integration/bootstrapApp-resume.test.ts`）
- [ ] 现有权限系统不回归（验证：`npm test -- tests/unit/tools/permissions/`）
- [ ] 现有 Agent Loop 不回归（验证：`npm test -- tests/unit/agent/`）
- [ ] 现有 TUI 权限弹窗不回归（验证：`npm test -- tests/unit/tui/PermissionPrompt*.test.*`）
- [ ] bootstrap 组装成功（验证：`npm test -- tests/integration/`）

## 构建与测试

- [ ] 全量测试通过（验证：`npm test`）
- [ ] 类型检查通过（验证：`npm run typecheck`）
- [ ] Lint 通过（验证：`npm run lint`）
- [ ] 构建通过（验证：`npm run build`）

## 安全、权限与回滚

- [ ] Plan/Review Agent 数据面只读不可被 yolo/auto/Steer 绕过（验证：T5/T9/T10/T13 相关测试）
- [ ] 用户显式控制面写仅限白名单并写 audit（验证：T6/T7/T10/T11）
- [ ] session 写锁防并发写（验证：`sessionLock` 测试）
- [ ] memory/permission TOCTOU 防护（验证：MemoryManager/PermissionManager/InteractionCoordinator 测试）
- [ ] 回滚可执行（验证：按任务回退新增模块后，旧 controller 路径与既有测试仍可通过；记录回滚命令与结果）

## 端到端

- [ ] 运行中：`Enter` steer、`Alt+Enter` queue、`/status` 即时打开
- [ ] `/stop` 后 queue paused，`/queue run` 恢复
- [ ] `/review` 得到只读结构化结果并恢复原模式
- [ ] `/clear "next"` 新建 session，`/session` 恢复旧 session 与 paused queue
- [ ] 重启后 queue 不自动 drain

## 验收记录

| 条目 | 当前变更集 hash | 实际结果 | 证据 | 状态 |
|------|-----------------|----------|------|------|
| AC1 parser |  |  |  | 待实现后填写 |
| AC2 registry |  |  |  | 待实现后填写 |
| AC3 dispatcher/runtime |  |  |  | 待实现后填写 |
| AC4 help/completion |  |  |  | 待实现后填写 |
| AC5 mode |  |  |  | 待实现后填写 |
| AC6 runtime matrix |  |  |  | 待实现后填写 |
| AC7 compact |  |  |  | 待实现后填写 |
| AC8 session |  |  |  | 待实现后填写 |
| AC9 memory |  |  |  | 待实现后填写 |
| AC10 permission |  |  |  | 待实现后填写 |
| AC11 status |  |  |  | 待实现后填写 |
| AC12 review |  |  |  | 待实现后填写 |
| AC13 steer |  |  |  | 待实现后填写 |
| AC14 queue |  |  |  | 待实现后填写 |
| AC15 stop |  |  |  | 待实现后填写 |
| AC16 interaction |  |  |  | 待实现后填写 |
| AC17 pure tests |  |  |  | 待实现后填写 |
| AC18 security |  |  |  | 待实现后填写 |
| AC19 e2e |  |  |  | 待实现后填写 |
| AC20 restart queue |  |  |  | 待实现后填写 |
| AC21 docs-only phase |  |  |  | 待实现后填写 |
| 全量测试 |  |  |  | 待实现后填写 |
| typecheck/lint/build |  |  |  | 待实现后填写 |
