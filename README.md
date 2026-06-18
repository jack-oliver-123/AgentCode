# AgentCode

AgentCode 是一个使用 TypeScript 构建的终端 AI 编程助手项目，目标是逐步实现类似 Claude Code 的终端工作流体验。

当前版本已经实现单会话 TUI 和一次工具调用闭环：可以在终端启动、读取配置、连接 Anthropic 或 OpenAI-compatible 流式 Provider、进行多轮上下文对话，并在单个用户 turn 内完成一次工具调用、工具结果回灌和最终回答。真实 CLI 行为通过 tmux/psmux E2E 验证。

## 当前能力

- TypeScript + ESM CLI，Node.js 20+。
- Ink/React 终端 TUI。
- 项目级和全局 YAML 配置加载。
- 首次启动自动创建 `.agentcode/config.yaml` 模板。
- Anthropic Messages streaming Provider。
- OpenAI-compatible Chat Completions streaming Provider。
- 当前进程内多轮会话上下文。
- 蓝白小猫风格 TUI：顶部小猫标识、横向分隔线、无左右大边框。
- 用户提示词左侧使用蓝色竖杠区分；assistant 回复不显示固定发言人标签。
- streaming 回复显示简短运行状态和动态效果，例如 Thinking / Writing。
- Tool runtime MVP：六个内置工具 `read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`search_code`。
- OpenAI-compatible `tool_calls` 和 Anthropic `tool_use` 流式解析。
- 单工具闭环：每个用户 turn 最多执行一个工具，随后把 redacted 工具结果回灌给模型生成最终回答。
- API key / Authorization / token 脱敏与 E2E 泄露检查。

## 当前边界

当前阶段是带工具系统 MVP 的单会话 TUI，但仍不实现：

- 多步 Agent Loop：每个用户 turn 最多执行一个工具，第二轮再次工具调用会被拒绝；
- 工具权限/审批 UI：`write_file`、`edit_file`、`run_command` 已有基础安全边界，但还没有交互式批准流程；
- MCP、plugins、hooks、skills、subagents；
- 多会话恢复或长期 memory；
- Plan/Build 权限模式；
- 文件 diff、checkpoint、undo/redo 工作流。

这些能力会在后续设计 permission layer、multi-step agent loop 和 session persistence 后再拆分实现。

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
npm test
npm test -- tests/unit/config/loadConfig.test.ts
npm run test:watch
npm run e2e:tmux
```

当前没有 lint 脚本。

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
- `docs/task02/spec.md`：纯对话 TUI 首版 spec。
- `docs/task02/plan.md`：纯对话 TUI 首版架构方案。
- `docs/task02/tasks.md`：纯对话 TUI 首版任务拆解。
- `docs/task02/checklist.md`：纯对话 TUI 首版验收记录。
- `docs/task03/spec.md`：TUI vNext spec。
- `docs/task03/plan.md`：TUI vNext 方案与开源参考取舍。
- `docs/task03/tasks.md`：TUI vNext 任务拆解。
- `docs/task03/checklist.md`：TUI vNext 验收记录。
- `docs/task04/spec.md`：工具系统 MVP spec。
- `docs/task04/plan.md`：工具系统架构方案、边界和风险。
- `docs/task04/tasks.md`：工具系统任务拆解。
- `docs/task04/checklist.md`：工具系统验收记录。

## 后续方向

后续若要继续向 Claude Code 类产品靠近，优先级不是继续加边框或文案，而是设计：

- session event taxonomy；
- 可滚动/可审阅 timeline；
- stop/cancel/retry；
- slash command / command palette；
- context usage 可视化；
- tool execution layer；
- permission and approval UI；
- session persistence / resume；
- diff/checkpoint/undo 工作流。
