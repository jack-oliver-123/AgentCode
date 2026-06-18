# Tool System Checklist

> 本清单记录 `docs/task04` 工具系统实现后的最终验收结果。每一项都应对应可运行命令、自动化测试或可观察行为；不要把未来计划写成已完成能力。

## 能力边界确认

- [x] 已实现工具系统公共类型、默认注册中心、统一 executor、workspace 路径防护和工具结果 redaction。
- [x] 已实现六个内置工具：`read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`search_code`。
- [x] OpenAI-compatible Provider 支持发送工具声明、禁用工具选择，并解析流式 `tool_calls` 参数碎片。
- [x] Anthropic Provider 支持发送工具声明、禁用工具选择，并解析流式 `tool_use` / `input_json_delta` 参数碎片。
- [x] `ChatSessionController` 支持单次工具闭环：首轮请求暴露工具、执行一个工具、redacted 工具结果以 Provider-native tool result 结构回灌、第二轮请求禁用工具、最终只提交第二轮 assistant 文本。
- [x] TUI 显示简短工具 activity，例如 `Using read_file`，不展示原始工具 JSON、stdout/stderr、stack trace 或 secret。
- [x] tmux/psmux E2E smoke 覆盖真实打包安装后的 CLI、纯文本两轮上下文、OpenAI mock 工具调用、真实 `read_file` fixture、最终工具回答和 sentinel secret 不泄漏。
- [x] 当前仍不是完整多步 Agent Loop：每个用户 turn 最多执行一个工具；第二轮再次工具调用会被拒绝。
- [x] 当前仍没有权限/审批 UI、Plan/Build 模式、MCP/plugins/hooks/skills/subagents、session persistence、diff/checkpoint/undo 工作流。

## 自动化验证记录

| 检查 | 命令 | 结果 | 证据 |
|------|------|------|------|
| 类型检查 | `npm run typecheck` | 通过 | `tsc --noEmit -p tsconfig.json` 成功退出。 |
| 全量测试 | `npm test` | 通过 | Vitest：21 个测试文件通过，263 个测试通过，2 个 skipped。 |
| 构建 | `npm run build` | 通过 | `tsc -p tsconfig.build.json` 成功退出。 |
| E2E smoke | `npm run e2e:tmux` | 通过 | 脚本输出 `tmux E2E smoke passed.`；该脚本会先执行 build。 |

说明：当前 `package.json` 没有 lint 脚本，因此本次验收不声明已运行 lint。

## 关键行为验收

### Tool runtime

- [x] Registry 可列出并按名查找六个内置工具，且 Provider 声明只包含 `name`、`description`、`inputSchema` 等协议需要的字段。
- [x] Executor 统一处理成功执行、非法 JSON、未知工具、参数无效、工具异常、超时和 redaction。
- [x] `resolveWorkspacePath` 将文件工具限制在 workspace 内，并覆盖 `..`、绝对路径、Windows 路径差异、symlink/junction 外指向等场景。
- [x] `redactToolResult` 在工具结果返回 Controller 前递归清理 API key、Authorization、Bearer/JWT/sentinel 等敏感值。

### Built-in tools

- [x] `read_file` 读取 workspace 内文本文件，返回路径、内容、字节数和截断状态；拒绝越界、缺失和非文本目标。
- [x] `write_file` 写入 workspace 内文件，默认不覆盖已有文件，只有显式 `overwrite: true` 才覆盖；失败路径不修改文件。
- [x] `edit_file` 仅在 `oldText` 唯一匹配时替换；0 次或多次匹配都返回结构化错误且不改文件。
- [x] `run_command` 在 workspace cwd 下执行一次性命令，返回 stdout/stderr/exitCode/timedOut/truncated，并限制 timeout 和输出大小。
- [x] `glob_files` 支持受控 glob 子集，返回 workspace 相对路径，默认跳过 `.git`、`node_modules`、`dist`，并支持结果截断。
- [x] `search_code` 支持文本和正则搜索，处理无效正则、大文件、默认排除目录、结果上限和 preview redaction。

### Provider adapters

- [x] OpenAI-compatible request body 能把工具声明映射为 function tools，`toolChoice: 'none'` 时不发送工具声明。
- [x] OpenAI-compatible stream parser 能按 tool call index 拼接 `function.arguments`，在 `finish_reason: "tool_calls"` 时产出规范化 `tool.call`。
- [x] OpenAI-compatible parser 对 invalid index / invalid argument fragment 返回协议错误，不静默容错为错误工具调用。
- [x] Anthropic request body 能把工具声明映射为 Messages `tools`，`toolChoice: 'none'` 时不发送工具声明。
- [x] Anthropic stream parser 能解析 `tool_use` block 和 `input_json_delta.partial_json`，并对缺失 id/name、非法 delta 返回协议错误。
- [x] 两个 Provider 的普通文本 streaming、thinking/error 行为保持回归通过。

### Session / TUI

- [x] 无工具普通对话路径保持原行为：streaming draft、assistant commit、失败 turn 上下文、并发提交保护均通过测试。
- [x] 工具成功时首轮 request 带 `tools` / `toolChoice: 'auto'`，执行一个工具后第二轮 request 使用 `toolChoice: 'none'` 且不携带 tools。
- [x] 工具失败时将结构化失败结果回灌给 Provider，而不是让会话崩溃。
- [x] 第二轮再次返回 `tool.call` 时不会执行第二个工具，并进入清晰的 protocol error。
- [x] 工具 activity 使用 registry 中的安全工具名；未知或恶意 provider tool name 在 TUI 中显示为泛化 `tool`。
- [x] `ui.show_thinking=false` 时 thinking 文本仍不会出现在 TUI render output 或 E2E pane capture 中。

### E2E / secret safety

- [x] E2E 会打包当前 package、安装到临时项目、启动真实 `agentcode` bin，而不是只调用源码测试入口。
- [x] E2E 保留两轮纯文本对话 smoke，并使用唯一 `streammarker` 验证可见部分流式状态，避免误匹配 “Waiting for the first token”。
- [x] E2E mock OpenAI server 会流式返回 `read_file` 工具调用参数碎片，AgentCode 读取临时 fixture 后，第二轮 mock response 返回 `Tool summary: fixture says tool loop works.`。
- [x] E2E 检查 sentinel API key 不出现在 tmux pane、pane log、mock SSE stdout、mock SSE stderr。
- [x] 如果 tmux/psmux 命令缺失或无法创建交互式 session，脚本会以环境阻塞退出，不把环境问题伪装为产品通过。

## Diff / 发布前检查

- [x] 文档只声明“一次工具调用闭环”，没有声称已实现完整多步 agent loop、权限系统、MCP/plugins/hooks/skills 或 subagents。
- [x] `.agentcode/` 仍应保持 git ignored，不提交真实 API key。
- [x] task04 使用的 sentinel secret 仅存在于测试断言/脱敏检查上下文中，不应出现在运行输出或发布配置中。
- [x] 最终提交前再次运行 `git status --short` 和 `git diff`，确认没有真实 API key、临时 E2E 项目、`.agentcode/` 或无关文件进入 diff；sentinel 仅作为测试常量和泄漏断言存在。

## 剩余风险与后续建议

- **权限系统缺失：** `write_file`、`edit_file`、`run_command` 已有工具级安全边界，但还没有交互式审批 UI；后续实现真实开发助手工作流前应优先设计 permission layer。
- **单工具上限：** 当前每个用户 turn 只允许一次工具调用，适合作为 task04 的安全 MVP；后续多步 agent loop 需要重新设计循环上限、用户中断、审计日志和失败恢复。
- **Provider 协议覆盖：** 已覆盖当前 OpenAI-compatible 和 Anthropic streaming 形态；后续接入更多兼容服务时应增加 fixture，避免协议方言差异导致 tool call 解析回退。
- **命令执行风险：** `run_command` 已限制 cwd、timeout、输出和 redaction，但没有 sandbox/allowlist/approval；默认暴露给模型前需结合权限系统再评估。 
