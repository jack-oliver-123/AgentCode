# AgentCode

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供项目上下文和操作指引。

## 项目概览

AgentCode 是一个使用 TypeScript 构建的终端 AI 编程助手项目，目标是实现类似 Claude Code 的能力。

当前阶段：`docs/task05` 的 Agent Loop 和结构化 System Prompt 已实现。仓库具备：可运行的 TypeScript CLI、首次启动配置引导、OpenAI/Anthropic 流式 Provider、蓝白小猫风格 Ink TUI、会话控制器、ReAct 多步工具执行循环、结构化 system prompt 系统、六个内置工具，并通过 psmux E2E smoke 测试验证真实 CLI 行为。

## 参考文档

每个 task 目录下包含 `spec.md`、`plan.md`、`tasks.md`、`checklist.md` 四件套：

| 目录 | 主题 |
|------|------|
| `docs/task01` | Claude Code 可观察架构研究（公开资料） |
| `docs/task02` | 纯对话 TUI 首版 |
| `docs/task03` | TUI vNext（蓝白小猫风格、无边框布局） |
| `docs/task04` | 工具系统 MVP（六工具 + 单工具闭环） |
| `docs/task05` | Agent Loop（ReAct 多步执行）+ 结构化 System Prompt |

参考这些文档时须区分：哪些是公开资料确认的事实，哪些是本项目自己的实现选择。不要把 Claude Code 未公开的内部实现当作已知事实。

## 语言与沟通

- 默认使用中文回答用户。
- 代码注释默认使用中文，除非周围代码已经形成明确的英文风格。
- 文档保持简洁、可执行、对后续开发有帮助。

## 常用命令

以下命令均来自当前 `package.json`，不要使用不存在的脚本名。运行环境：Node.js >= 18，测试框架为 Vitest。

- 安装依赖：`npm install`
- 本地开发运行 CLI：`npm run dev`
- 构建：`npm run build`
- 类型检查：`npm run typecheck`
- 运行全部测试：`npm test`（Vitest）
- 运行指定测试文件：`npm test -- tests/unit/config/loadConfig.test.ts`
- watch 模式运行测试：`npm run test:watch`
- E2E smoke 测试：`npm run e2e:tmux`（需要 psmux/tmux）

当前没有 lint 脚本；不要声称已运行 lint。

## 启动与配置

- 开发启动使用 `npm run dev`；构建后可用 `node dist/cli/main.js` 运行构建产物。
- `package.json` 的 `bin.agentcode` 指向 `./dist/cli/main.js`；如果本机 `agentcode` 命令命中其他工具，优先使用 `npm run dev` 或 `node dist/cli/main.js` 验证当前仓库。
- 首次启动如果找不到项目或全局配置，会自动创建项目级 `.agentcode/config.yaml` 模板，并提示用户填入真实 API key 后重新启动。
- `.agentcode/` 必须保持 git ignore；配置目录和配置文件会按 owner-only 权限创建/收紧，避免 API key 被误提交或过度暴露。
- 生成模板中的 `api_key: replace-with-your-api-key` 只是占位符，后续启动会拒绝该占位符，不会用它发起 Provider 请求。

## 当前能力与约束

已实现：
- ReAct 多步工具执行（Agent Loop）；模型可连续调用多个工具直到产出最终回答。
- 内置工具：`read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`search_code`。
- 工具执行经过 workspace 路径边界、timeout/输出限制和 redaction。
- 结构化 system prompt 系统，按上下文动态拼装提示词。
- Plan/Full 模式切换（Tab 键），plan 模式使用 `submit_plan` 工具。

尚未实现：
- 工具权限/审批 UI、MCP、plugins、hooks、skills、subagents、多会话恢复、长期 memory。

TUI 规范：
- 蓝白色调、顶部小猫标识、横向分隔线、无左右大边框。
- 用户提示词左侧蓝色竖杠；assistant streaming 时显示运行状态 + spinner。
- 工具 activity 只显示简短安全状态（如 `Using read_file`），不展示原始 JSON、stdout/stderr、stack trace 或 secret。
- `ui.show_thinking=false` 时 thinking 文本不得泄漏到任何输出。

## 推荐工作方式

**底线：** 干净设计优先于向后兼容。旧架构不合适就重构，不设兜底兼容层，不保留过渡代码。

发现 bug 或需要改进时：

1. **不要直接修改代码**。先在 GitHub 创建 issue（`gh issue create`），描述清楚现象、根因分析和建议修复方案。
2. 等用户确认或分配后，再按 issue 内容实施修改。
3. 踩坑记录可以同步写入 CLAUDE.md，但代码变更必须有对应 issue。

实现功能前：

1. 先检查现有文件和文档，尤其是 `docs/task01/claude-code-implementation-research.md`。
2. 如果功能会影响架构，先产出或更新简短的 spec/plan/checklist，再开始编码。
3. 优先做小而可验证的改动。
4. 不要修改无关的用户自建文件。
5. 不要假设不存在的项目脚本或依赖；必须先检查 manifest。
6. **任何代码修改必须首先符合对应 task 文档（spec.md、checklist.md）中的验收标准（AC）。** 禁止以优化、精简等理由违反已定义的 AC 约束。如果优化方案与现有 AC 冲突，必须先告知用户具体冲突点，获得用户批准后才能修改。

实现功能后：

1. 运行 `npm run typecheck` 和相关测试。
2. 运行 `npm run e2e:tmux` 做端到端验证（需要 psmux/tmux；不可用时记录为环境阻塞，不要声称已通过）。
3. 如果存在 `checklist.md`，按清单逐项验收并记录证据。

## 踩坑记录

以下是开发过程中遇到的问题和解决方案，遇到类似问题时直接参考：

### tsx 在 Git Bash 后台进程中 stdout 被吞

- **现象：** `npx tsx script.ts > file &` 在后台运行时 stdout 为空，URL file 永远不写入
- **根因：** `npx tsx` 在 Git Bash 背景进程中的 stdout 管道有问题
- **解决：** 改用 `node --import tsx/esm script.ts`

### OpenAI 兼容代理层 tool call delta 发送空字符串

- **现象：** `protocol_error: OpenAI-compatible provider returned an invalid tool call name.`
- **根因：** 某些 OpenAI 兼容代理（OneAPI/New API 等）在流式 tool call 的后续 delta chunk 中会发送 `"name": ""` 或 `"id": ""`（空字符串），而非省略该字段
- **解决：** 将 `name`/`id` 的空字符串视为"无更新"跳过，而非视为非法值报错

### exactOptionalPropertyTypes 导致 undefined 赋值报错

- **现象：** `Type 'AbortSignal | undefined' is not assignable to type 'AbortSignal'`
- **根因：** tsconfig 开启了 `exactOptionalPropertyTypes`，可选字段不能直接赋 undefined
- **解决：** 使用 spread 模式：`...(signal !== undefined ? { signal } : {})`

### 扩展接口导致所有 mock 实现编译报错

- **现象：** 给 `ToolRegistry` 加了 `filterByRisk()` 后，所有测试中手写的 mock registry 都报缺少属性
- **教训：** 修改公共接口后必须立刻全局搜索所有 mock/stub 实现并同步更新
- **快速定位：** `npx tsc --noEmit` 会一次性列出所有缺失点

### 代理网关不支持复杂嵌套 tool schema（Issue #11）

- **现象：** plan 模式下发消息返回 `provider_error: Upstream request failed`；full 模式正常
- **根因：** OneAPI/New API 等代理网关对 `array → object` 嵌套 tool schema 处理有 bug
- **解决：** 将复杂参数声明为 `string` 类型，模型传 JSON 字符串，validate 侧 `JSON.parse` 校验。`ToolJsonSchemaProperty` 仅保留标量类型
- **教训：** 代理网关对复杂 JSON Schema 支持不可靠；用 string + 运行时解析更稳健
- **参考：** `src/tools/builtins/submitPlan.ts`

### 文件系统测试在并行运行时 flaky

- **现象：** `write-file.test.ts`、`run-command.test.ts`、`edit-file.test.ts` 全量运行时偶尔失败，单独运行通过
- **根因：** 文件系统操作有时间竞争，或 timeout 测试对系统负载敏感
- **处理：** 非逻辑 bug；单独验证通过即可，全量运行的偶尔失败可忽略

## 源码结构

```
src/
├── agent/          # ReAct Agent Loop（多步工具执行循环）
├── app/            # 应用入口、顶层组装
├── cli/            # CLI 参数解析、入口 main.ts
├── config/         # 配置加载、首次引导
├── providers/      # LLM Provider（OpenAI/Anthropic 流式协议）
├── session/        # 会话控制器、消息历史
├── shared/         # 公共类型和工具函数
├── system-prompt/  # 结构化 system prompt 拼装
├── tools/          # 工具注册、内置工具实现、执行沙箱
└── tui/            # Ink React TUI 组件
```
