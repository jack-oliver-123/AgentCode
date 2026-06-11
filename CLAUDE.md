# AgentCode

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供项目上下文和操作指引。

## 项目概览

AgentCode 是一个使用 TypeScript 构建的终端 AI 编程助手项目，目标是实现类似 Claude Code 的能力。

当前阶段：`docs/task02` 的纯对话 TUI 首版已实现，仓库已具备可运行的 TypeScript CLI、配置加载、OpenAI/Anthropic 流式 Provider、Ink TUI、会话控制器和 tmux E2E smoke 测试。

当前重要参考文档：

- `docs/task01/claude-code-implementation-research.md` — 基于公开资料整理的 Claude Code 可观察架构研究，覆盖 CLI/会话流程、工具调用、权限边界、sandbox、MCP/plugins/hooks/skills、memory 和分发机制。
- `docs/task02/spec.md` — 纯对话 TUI 首版需求与验收标准。
- `docs/task02/plan.md` — 首版架构方案、模块边界和风险说明。
- `docs/task02/tasks.md` — 首版实现任务拆解。
- `docs/task02/checklist.md` — 首版验收清单和最终验证记录。

设计 AgentCode 时可以参考这些文档，但必须区分：哪些是公开资料确认的事实，哪些是本项目自己的实现选择。不要把 Claude Code 未公开的内部实现当作已知事实。

## 语言与沟通

- 默认使用中文回答用户。
- 代码注释默认使用中文，除非周围代码已经形成明确的英文风格。
- 文档保持简洁、可执行、对后续开发有帮助。

## 常用命令

以下命令均来自当前 `package.json`，不要使用不存在的脚本名。

- 安装依赖：`npm install`
- 本地开发运行 CLI：`npm run dev`
- 构建：`npm run build`
- 类型检查：`npm run typecheck`
- 运行全部测试：`npm test`
- 运行指定测试文件：`npm test -- tests/unit/config/loadConfig.test.ts`
- watch 模式运行测试：`npm run test:watch`
- tmux 端到端 smoke 测试：`npm run e2e:tmux`

当前没有 lint 脚本；不要声称已运行 lint。

## 推荐工作方式

实现功能前：

1. 先检查现有文件和文档，尤其是 `docs/task01/claude-code-implementation-research.md`。
2. 如果功能会影响架构，先产出或更新简短的 spec/plan/checklist，再开始编码。
3. 优先做小而可验证的改动。
4. 不要修改无关的用户自建文件。
5. 不要假设不存在的项目脚本或依赖；必须先检查 manifest。

实现功能后：

1. 在相关自动化检查存在后，运行对应检查。
2. 使用 tmux 做端到端测试：
   - 优先运行 `npm run e2e:tmux`；
   - 该脚本会打包当前项目、安装到临时项目、启动真实 `agentcode` bin、输入两轮真实对话，并检查流式输出、上下文和 API key 不泄露；
   - 如果 tmux 不可用，必须明确记录为环境阻塞，不要声称 E2E 已通过；
   - 如果存在 `checklist.md`，按清单逐项验收。
3. 在任务记录或文档中记录验证证据。

## 架构方向

本项目目标是实现一个终端 AI 编程助手。根据当前研究文档，可能包含以下高层模块：

- CLI/session runtime；
- model-driven agent loop；
- tool execution layer；
- permission and safety boundary；
- project memory/context loading；
- terminal interaction and end-to-end testing harness。

这些只是当前架构方向，并不代表仓库中已经存在对应实现。引用具体路径、命令或模块前，必须先检查当前文件状态。
