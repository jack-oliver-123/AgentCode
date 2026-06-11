# AgentCode TUI vNext Checklist

> 本清单用于验证 Issue #2 的 TUI vNext 是否在不扩大运行时能力边界的前提下，提升了纯对话单会话体验。每一项都应通过测试、tmux capture、代码审查或人工观察验证。

## 审查来源

- Issue #2：TUI 体验向 Claude Code 对齐，并参考 OpenCode、Crush、Aider 等开源项目。
- `docs/task02/spec.md`：当前阶段仍是纯对话 TUI，不实现工具、文件、shell、MCP、插件或长期记忆。
- `docs/task03/spec.md`：TUI vNext 的目标、范围、非目标和验收标准。
- `docs/task03/plan.md`：展示层升级、会话内核稳定、未来扩展槽位文档化的方案选择。

## 文档完整性

- [x] `docs/task03/spec.md` 明确 TUI vNext 是纯对话单会话体验升级。
- [x] `docs/task03/spec.md` 明确列出不做 tool use、文件读写、shell execution、MCP、plugins、hooks、skills、subagents 和长期 memory。
- [x] `docs/task03/plan.md` 记录 OpenCode、Crush、Aider 的参考取舍，且不把公开项目能力误写成 AgentCode 已实现能力。
- [x] `docs/task03/plan.md` 明确 TUI 改造主要发生在 `src/tui/`，默认不修改 `ChatSessionController` 会话语义。
- [x] `docs/task03/tasks.md` 将后续实现拆分为可独立验证的小任务。
- [x] `docs/task03/checklist.md` 提供最终验证记录位置。

## Header / Status

- [x] 启动 TUI 后，顶部信息区显示 `AgentCode` 产品名。
- [x] 顶部信息区显示持续带填充色的小猫标识。
- [x] TUI 主色调采用蓝白色调。
- [x] 主界面不再使用左右两侧大边框包裹 Header、Transcript、Notice 或 Composer。
- [x] 顶部信息区显示当前 model。
- [x] 顶部信息区显示当前 provider/protocol。
- [x] 顶部信息区显示 config source，例如 `project` 或 `global`。
- [x] 顶部信息区显示当前工作目录的简短标识。
- [x] 顶部信息区显示用户可理解的状态 label，而不只暴露内部枚举。
- [x] streaming 时，顶部状态能体现正在生成。
- [x] error 时，顶部状态能体现需要关注或可恢复。

## Transcript

- [x] 新会话无消息时显示空态引导，而不是只有空白区域。
- [x] user turn 和 assistant turn 在视觉和文案上可区分。
- [x] user turn 不显示固定发言人标签，并通过左侧蓝色竖杠区分。
- [x] assistant completed turn 不显示固定发言人标签，保持正文流式工作台观感。
- [x] assistant streaming draft 与已完成 assistant message 可区分。
- [x] streaming draft 持续显示最新内容，不等待完整响应结束后一次性展示。
- [x] streaming draft 显示简短运行状态和动态效果，例如 Thinking / Writing。
- [x] transcript 截断较早消息时，显示隐藏历史数量提示。
- [x] transcript 截断时，最新消息和最新 draft 始终保持可见。
- [x] `ui.show_thinking=false` 时，thinking 文本不出现在 transcript 中。
- [x] `ui.show_thinking=true` 时，thinking 展示仍与最终回答区分，不混入普通 assistant 正文。

## Notice / Error

- [x] Provider public error 与 assistant 正文分离展示。
- [x] config/network/auth/rate limit/protocol 等错误显示用户可理解的 message。
- [x] error 状态下，用户仍可以继续输入下一轮消息。
- [x] 错误展示不包含原始 provider JSON、完整配置对象或 secret。
- [x] 如展示 retryable/code 信息，其文案不误导用户认为系统会自动重试。

## Composer / Input

- [x] idle 状态下，输入区显示清晰 placeholder 或操作提示。
- [x] Enter 提交非空输入的行为不回归。
- [x] 空输入不会提交。
- [x] backspace/delete 按 grapheme 删除的行为不回归。
- [x] streaming 状态下，输入区禁用并显示等待原因。
- [x] error 状态下，输入区恢复可输入。
- [x] 本期不实现多行编辑器、命令历史、slash command 或 command palette。

## 安全与范围边界

- [x] TUI vNext 不新增文件读取、文件编辑或文件写入能力。
- [x] TUI vNext 不新增 shell execution、test execution 或 git execution 能力。
- [x] TUI vNext 不新增 tool use、tool event、permission prompt 或 approval runtime。
- [x] TUI vNext 不新增 MCP、plugins、hooks、skills、subagents 或长期 memory runtime。
- [x] TUI vNext 不渲染不可用按钮、假快捷键或未来能力占位控件。
- [x] API key、Authorization header、token 和 sentinel secret 不出现在 TUI、stderr/stdout、tmux pane capture 或测试输出。
- [x] 发往 Provider 的请求体不因 TUI 改造新增 `tools`、`tool_choice`、`functions`、`function_call` 等字段。

## 自动化验证

- [x] `npm run typecheck` 通过。
- [x] `npm test -- tests/integration/cli/cli.test.tsx` 通过。
- [x] `npm test` 通过。
- [x] `npm run build` 通过。
- [x] 如 tmux 可用，`npm run e2e:tmux` 通过。
- [x] 如 tmux 不可用，最终记录明确说明环境阻塞，不声称 E2E 已通过。

## tmux E2E 观察点

- [x] 真实 package tarball 安装后，`agentcode` bin 可以启动 TUI。
- [x] 首屏能看到顶部状态区和输入区提示。
- [x] 第一轮输入后，pane 中先出现部分回复，再出现完整回复，证明流式可见性未回归。
- [x] 第二轮输入能引用第一轮上下文。
- [x] streaming 状态下输入区显示等待反馈。
- [x] tmux pane 和 pane log 不包含 sentinel API key。

## 最终验收记录

> 实现完成后填写以下记录。

- `npm run typecheck`：通过，TypeScript 全项目类型检查无错误。
- `npm test -- tests/integration/cli/cli.test.tsx`：通过，1 个测试文件、13 个测试全部通过。
- `npm test`：通过，10 个测试文件、128 个测试全部通过。
- `npm run build`：通过，`tsc -p tsconfig.build.json` 成功生成构建产物。
- `npm run e2e:tmux`：通过，真实 package tarball 安装、`agentcode` bin 启动、tmux 两轮对话、流式输出和 sentinel API key 不泄露检查均通过。
- 范围边界检查：通过，`src/` 未发现 `child_process`、`spawn`、`exec`、tool/MCP/plugin/hook/subagent/long-term memory 运行时入口。
- Secret 泄露检查：通过，现有 CLI/TUI/tmux 测试继续覆盖 sentinel API key 不泄露。
- 残余风险：本轮仅实现纯对话单会话 TUI 展示增强；slash command、command palette、多会话、权限确认和工具事件仍需后续独立设计。
