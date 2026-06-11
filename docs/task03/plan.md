# AgentCode TUI vNext Plan

## 方案选择摘要

- 最终选择：采用“展示层升级 + 会话内核保持稳定”的方案，先改进单会话纯对话 TUI 的信息架构、状态反馈和 transcript/composer 可读性。
- 选择理由：当前 `docs/task02` 已验证配置、Provider streaming、会话上下文和 tmux E2E；Issue #2 需要体验升级，但不需要同时引入新的 Agent runtime 能力。
- 明确不选：不采用“一次性实现 Claude Code/OpenCode/Crush 全量能力”的方案，因为它会越过当前 tool execution、permission layer、session persistence 尚未设计的边界。
- 明确不选：不采用“只改颜色和边框”的方案，因为用户需求关注的是 Claude Code 类交互体验，核心是状态、上下文和可恢复性，而不是表面样式。

## 当前架构复用点

### TUI 根组件

`src/tui/App.tsx` 当前组合：

- `StatusBar`：展示 model/provider/config/status。
- `TranscriptPane`：展示已完成消息和当前 draft。
- inline error block：展示 `state.lastError`。
- `InputPane`：接收输入，streaming 时禁用。

TUI vNext 应继续让 `App` 只做组合和状态派发，不把 Provider 协议、配置解析或会话提交规则写进组件。

### 会话控制器

`src/session/ChatSessionController.ts` 当前负责：

- 用户提交后追加 user message。
- 调用 Provider stream。
- 聚合 `content.delta` 到 assistant draft。
- 聚合 `thinking.delta` 到 hidden draft。
- 收到 `response.complete` 后提交 assistant message。
- 出错时丢弃 assistant draft、保留本轮 user message、进入 error 状态。

TUI vNext 不改变这些规则。尤其不能因为视觉上想展示更多信息，就把失败 draft 写入上下文或让 thinking 混入 transcript。

### 测试基础

现有测试已经提供三类验证方式：

- `tests/integration/cli/cli.test.tsx`：使用 Ink `renderToString` 验证 TUI 可见文本。
- `tests/helpers/FakeProvider.ts`：模拟 streaming、error 和阻塞状态。
- `tests/e2e/tmux/agentcode-smoke.sh`：打包安装真实 bin，验证 tmux 交互、流式输出、多轮上下文和 secret 不泄露。

TUI vNext 应复用这些测试，不引入脆弱的完整布局快照。

## 开源参考取舍

### OpenCode

可借鉴：

- 公开 README 展示了 terminal UI 方向。
- build/plan agent 的存在说明“模式边界”和“权限边界”需要在 UI 中显式表达。
- plan 模式默认不编辑文件、bash 需询问，这说明未来 AgentCode 若引入工具能力，TUI 需要清楚展示执行权限。

本期不做：

- 不实现 build/plan/general agent。
- 不实现 subagent 入口。
- 不实现 bash approval 或编辑权限策略。

落到本期的设计原则：

- 当前只有纯对话模式，所以不要渲染 mode tab。
- 未来 mode strip 可以放在顶部信息区下方，但 task03 只在文档中预留。

### Crush

可借鉴：

- session-based terminal assistant 强调 busy/attached/session 状态。
- command palette 和 skills 说明命令入口应有清晰来源和层级。
- 工具默认审批、可预允许或 yolo，说明权限确认是独立 UI 层，不应混在普通 assistant 文本中。
- 模型切换能保留上下文，说明 provider/model 信息需要稳定可见。

本期不做：

- 不实现 session picker。
- 不实现 command palette。
- 不实现 permission prompt。
- 不实现模型切换。

落到本期的设计原则：

- 顶部信息区必须稳定显示 model/provider/config/source/status。
- 未来 approval bar 应作为 transcript 和 composer 之间的独立区域，而不是伪装成 assistant 消息。

### Aider

可借鉴：

- 命令式终端体验需要清楚展示当前上下文和下一步可操作项。
- repo map、git workflow、test/fix loop 说明 coding agent 的核心价值最终来自 repo-aware 工作流。
- 普通 git 工具可用于 diff/undo 的理念说明未来 AgentCode 不应把所有工作流都藏在黑盒 UI 中。

本期不做：

- 不实现 repo map。
- 不执行 git/test/lint。
- 不修改文件或自动提交。

落到本期的设计原则：

- 输入区和错误区要告诉用户下一步能做什么。
- 不渲染“run tests”“apply patch”等未来能力按钮。

## 信息架构设计

TUI vNext 采用四层垂直结构：

1. Header / Status
   - 产品名：AgentCode。
   - Runtime facts：model、provider、config source、cwd basename。
   - Session state：ready、thinking/generating、error。
   - Hint：简短操作提示，例如 `Enter to send` 或 `Waiting for response`。

2. Transcript
   - 空态引导。
   - user turns。
   - assistant completed turns。
   - assistant streaming draft。
   - hidden history count。
   - thinking 可选展示仍受 `ui.showThinking` 控制。

3. Notice / Error
   - public error 与正文分离。
   - 未来 permission/approval bar 的预留位置。
   - 本期只展示 error/notice，不展示工具权限 UI。

4. Composer
   - 当前输入。
   - placeholder。
   - disabled reason。
   - 基础输入提示。

## 组件设计

### App

职责：

- 从 `useChatController(controller)` 获取会话状态。
- 计算展示层状态，例如 `isStreaming`、`hasError`、status label。
- 组合 Header、Transcript、Notice、Composer。

不做：

- 不解析 slash command。
- 不管理 tool execution。
- 不保存会话历史到磁盘。

### StatusBar / HeaderBar

当前 `StatusBar` 可以选择原地增强，或重命名/新增 `HeaderBar`。推荐先原地增强，降低改动面。

职责：

- 接收 `resolvedConfig`、`status`、`cwdLabel` 等展示输入。
- 输出结构化状态文本。
- 在窄终端下仍保留最关键字段：model、provider、status。

### TranscriptPane

职责：

- 渲染空态、历史消息、draft、hidden count。
- 保持 latest messages 和 latest draft 可见。
- 控制 thinking 是否展示。

不做：

- 不把 error 当 assistant 消息渲染。
- 不接收 Provider 原始事件。

### NoticeBar

可新增组件，用于统一 error/notice 展示。

职责：

- 渲染 public error code/message/retryable hint。
- 与 transcript 正文分离。
- 为未来 approval bar 留出独立区域设计。

本期只做 error notice，不做 permission prompt。

### InputPane / ComposerPane

当前 `InputPane` 可以选择原地增强。推荐先保留文件名，避免无意义迁移。

职责：

- 单行输入。
- Enter 提交。
- backspace/delete 删除 grapheme。
- streaming disabled 时展示等待原因。

不做：

- 不实现多行编辑器。
- 不实现命令历史。
- 不实现 slash command 解析。

## 状态设计

### Domain state

继续来自 `ChatSessionState`：

- `messages`
- `draft`
- `status: idle | streaming | error`
- `lastError`

### View state

TUI 可以在组件内部维护纯展示状态，例如当前输入文本。任何会影响 Provider 请求、上下文提交、错误恢复的状态都不应放在 TUI 层私自维护。

### 状态文案映射

建议在 TUI 层定义稳定映射：

- `idle` -> `ready`
- `streaming` -> `generating`
- `error` -> `needs attention`

这只是展示层 label，不改变 session state enum。

## 未来扩展槽位

以下只作为文档设计，不在 task03 渲染不可用控件：

- Mode strip：未来 build/plan/chat 等模式可放在 Header 下方。
- Command palette：未来可由 composer 或顶部 hint 暴露，但需要独立命令解析设计。
- Approval bar：未来 tool execution 权限确认应放在 Transcript 和 Composer 之间。
- Session rail/picker：未来多会话能力需要新的 session persistence，不应在当前 App 假装存在。
- Tool event timeline：未来工具调用结果应是独立 event 类型，不应混入 assistant text message。

## 实现顺序

1. 文档冻结
   - 新建 `docs/task03/spec.md`、`plan.md`、`tasks.md`、`checklist.md`。
   - 明确本期边界和验收。

2. Header/Status 增强
   - 修改 `src/tui/components/StatusBar.tsx`。
   - 更新 `tests/integration/cli/cli.test.tsx`。

3. Transcript 增强
   - 修改 `src/tui/components/TranscriptPane.tsx`。
   - 覆盖空态、hidden count、draft、thinking hidden。

4. Notice/Error 分层
   - 可新增 `src/tui/components/NoticeBar.tsx`。
   - 修改 `src/tui/App.tsx`，把 error block 从内联 JSX 收敛为组件。

5. Composer 增强
   - 修改 `src/tui/components/InputPane.tsx`。
   - 保持输入语义不变，增强提示和 disabled reason。

6. 回归验证
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `npm run e2e:tmux`，如 tmux 不可用则记录环境阻塞。

## 风险与缓解

- R1: UI 改造破坏流式可见性  
  缓解：保留 tmux 对 partial output 的检查，新增 draft 可见断言。

- R2: 视觉文案过多导致窄终端不可读  
  缓解：header 字段按重要性降级，测试只断言关键字段存在。

- R3: 错误展示泄露 secret  
  缓解：继续复用 `PublicError` 和现有脱敏测试；不直接展示原始配置或 provider JSON。

- R4: 未来能力预留变成 dead UI  
  缓解：只在文档中记录未来槽位，本期不渲染不可用按钮、快捷键或命令。

- R5: 为 UI 方便改动 session 语义  
  缓解：task03 默认不改 `ChatSessionController`；如必须改，需要单独说明并补会话单元测试。

## 回滚策略

- 文档变更可独立保留，不影响运行时。
- TUI 组件改造应分阶段提交；若某一阶段造成 E2E 不稳定，可回滚对应组件而不影响 Provider/session/config 层。
- 不修改 Provider 和配置层，避免 UI 任务影响模型请求行为。
