# AgentCode

AgentCode 是一个使用 TypeScript 构建的终端 AI 编程助手项目，目标是逐步实现类似 Claude Code 的终端工作流体验。

当前版本实现了完整的 ReAct 多步 Agent Loop、工具权限/审批系统和 MCP 客户端集成：可以在终端启动、读取配置、连接 Anthropic 或 OpenAI-compatible 流式 Provider、进行多轮上下文对话，并在单个用户 turn 内连续调用多个工具直到产出最终回答。真实 CLI 行为通过 tmux/psmux E2E 验证。

## 当前能力

- TypeScript + ESM CLI，Node.js 20+。
- Ink/React 终端 TUI，蓝白小猫风格：顶部小猫标识、横向分隔线、无左右大边框。
- 项目级和全局 YAML 配置加载。
- 首次启动自动创建 `.agentcode/config.yaml` 模板。
- Anthropic Messages streaming Provider。
- OpenAI-compatible Chat Completions streaming Provider。
- 当前进程内多轮会话上下文。
- ReAct 多步工具执行（Agent Loop）：模型可连续调用多个工具直到产出最终回答。
- 内置工具：`read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`search_code`。
- 工具执行经过 workspace 路径边界、timeout/输出限制和 redaction。
- 工具权限系统：风险分级（low/medium/high）、交互式审批 UI、allowlist 持久化。
- MCP 客户端集成：通过配置连接外部 MCP server，工具自动注册到 ToolRegistry。
- Plan/Full 模式切换（Tab 键），plan 模式使用 `submit_plan` 工具。
- 结构化 system prompt 系统，按上下文动态拼装提示词。
- API key / Authorization / token 脱敏与 E2E 泄露检查。

## 当前边界

当前阶段不实现：

- plugins、hooks、subagents；
- 多会话恢复或长期 memory；
- 文件 diff、checkpoint、undo/redo 工作流。

## 安装依赖

```bash
npm install
```

## 开发启动

```bash
npm run dev
```

如果缺少配置，首次启动会自动创建：

```text
.agentcode/config.yaml
```

然后退出并提示填入真实 API key。编辑配置后再次运行 `npm run dev`。

## 构建和运行

```bash
npm run build
node dist/cli/main.js
```

`package.json` 中的 npm bin 为：

```json
{
  "bin": {
    "agentcode": "./dist/cli/main.js"
  }
}
```

如果本机直接运行 `agentcode` 命中了其他可执行文件，请优先用 `npm run dev` 或 `node dist/cli/main.js` 验证当前仓库。

## 配置文件

AgentCode 按以下顺序查找配置：

1. 从当前工作目录向上查找最近的 `.agentcode/config.yaml`。
2. 如果项目配置不存在，读取用户目录下的 `~/.agentcode/config.yaml`。
3. 如果都不存在，自动创建项目级 `.agentcode/config.yaml` 模板。

示例配置：

```yaml
protocol: anthropic
model: claude-sonnet-4-6
base_url: https://api.anthropic.com/v1
api_key: replace-with-your-api-key
thinking:
  enabled: false
request:
  timeout_ms: 120000
  headers: {}
ui:
  show_thinking: false
```

注意：

- `replace-with-your-api-key` 是占位符，不能用于真实启动。
- `.agentcode/` 已加入 `.gitignore`，不要提交真实 API key。
- 自动创建的配置目录和文件会尽量使用 owner-only 权限。
- 如果项目配置存在但非法，AgentCode 会直接报错，不会回退到全局配置，避免误用账号或模型。

## 常用命令

```bash
npm run dev
npm run build
npm run typecheck
npm run lint          # Biome 静态检查（只读）
npm test
npm test -- tests/unit/config/loadConfig.test.ts
npm run test:watch
npm run e2e:tmux
```

`npm run format` 和 `npm run check` 会写入文件，只在有代码修改授权时运行。

## 验证

推荐在修改后运行：

```bash
npm run typecheck
npm test
npm run build
npm run e2e:tmux
```

`npm run e2e:tmux` 会：

- 构建项目；
- 打包当前 package；
- 安装到临时项目；
- 写入临时 `.agentcode/config.yaml`；
- 启动真实 `agentcode` bin；
- 在 tmux/psmux 中输入两轮真实对话；
- 触发 mock OpenAI 工具调用并读取临时 fixture；
- 检查流式输出、多轮上下文、工具最终回答和 sentinel API key 不泄露。

如果环境没有 tmux/psmux 兼容命令，需要记录为环境阻塞，不要声称 E2E 已通过。

## 文档

- `docs/task01/claude-code-implementation-research.md`：Claude Code 可观察架构研究。
- `docs/task02/`：纯对话 TUI 首版 spec/plan/tasks/checklist。
- `docs/task03/`：TUI vNext（蓝白小猫风格）spec/plan/tasks/checklist。
- `docs/task04/`：工具系统 MVP spec/plan/tasks/checklist。
- `docs/task05/`：Agent Loop（ReAct 多步执行）+ 结构化 System Prompt。
- `docs/task06/`：工具权限系统（风险分级 + 审批 UI）。
- `docs/task07/`：MCP 客户端集成。

## 后续方向

后续若要继续向 Claude Code 类产品靠近，优先级方向：

- session event taxonomy；
- 可滚动/可审阅 timeline；
- stop/cancel/retry；
- slash command / command palette；
- context usage 可视化；
- session persistence / resume；
- diff/checkpoint/undo 工作流。
