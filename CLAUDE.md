# AgentCode

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供项目上下文和操作指引。

## 项目概览

AgentCode 是一个使用 TypeScript 构建的终端 AI 编程助手项目，目标是实现类似 Claude Code 的能力。

当前阶段：`docs/task04` 的工具系统 MVP 已实现。仓库已具备可运行的 TypeScript CLI、首次启动配置引导、OpenAI/Anthropic 流式 Provider、蓝白小猫风格 Ink TUI、会话控制器、六个内置工具和单工具调用闭环，并通过 tmux/psmux E2E smoke 测试验证真实 CLI 行为。

当前重要参考文档：

- `docs/task01/claude-code-implementation-research.md` — 基于公开资料整理的 Claude Code 可观察架构研究，覆盖 CLI/会话流程、工具调用、权限边界、sandbox、MCP/plugins/hooks/skills、memory 和分发机制。
- `docs/task02/spec.md` — 纯对话 TUI 首版需求与验收标准。
- `docs/task02/plan.md` — 首版架构方案、模块边界和风险说明。
- `docs/task02/tasks.md` — 首版实现任务拆解。
- `docs/task02/checklist.md` — 首版验收清单和最终验证记录。
- `docs/task03/spec.md` — TUI vNext 需求与验收标准，记录蓝白小猫风格、无左右大边框、运行状态和 transcript 交互。
- `docs/task03/plan.md` — TUI vNext 方案、开源参考取舍、组件边界和未来扩展槽位。
- `docs/task03/tasks.md` — TUI vNext 后续实现任务拆解。
- `docs/task03/checklist.md` — TUI vNext 验收清单和最终验证记录。
- `docs/task04/spec.md` — 工具系统 MVP 需求与验收标准，覆盖六个内置工具、Provider tool call 协议、单工具闭环和安全边界。
- `docs/task04/plan.md` — 工具系统架构方案、模块边界、风险与回滚策略。
- `docs/task04/tasks.md` — 工具系统实现任务拆解。
- `docs/task04/checklist.md` — 工具系统验收清单和最终验证记录。

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
- psmux 端到端 smoke 测试：`npm run e2e:tmux`（脚本名暂沿用 tmux；在 Windows 上使用 psmux/tmux 兼容命令）

当前没有 lint 脚本；不要声称已运行 lint。

## 启动与配置

- 开发启动使用 `npm run dev`；构建后可用 `node dist/cli/main.js` 运行构建产物。
- `package.json` 的 `bin.agentcode` 指向 `./dist/cli/main.js`；如果本机 `agentcode` 命令命中其他工具，优先使用 `npm run dev` 或 `node dist/cli/main.js` 验证当前仓库。
- 首次启动如果找不到项目或全局配置，会自动创建项目级 `.agentcode/config.yaml` 模板，并提示用户填入真实 API key 后重新启动。
- `.agentcode/` 必须保持 git ignore；配置目录和配置文件会按 owner-only 权限创建/收紧，避免 API key 被误提交或过度暴露。
- 生成模板中的 `api_key: replace-with-your-api-key` 只是占位符，后续启动会拒绝该占位符，不会用它发起 Provider 请求。

## 当前 TUI 与工具约束

- 当前 TUI 是单会话体验，已支持一次工具调用闭环，但不是完整多步 Agent Loop：每个用户 turn 最多执行一个工具，第二轮再次返回工具调用会被拒绝。
- 当前内置工具为 `read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`search_code`；工具执行必须经过 workspace 路径边界、timeout/输出限制和 redaction。
- 当前还没有工具权限/审批 UI、Plan/Build 模式、MCP、plugins、hooks、skills、subagents、多会话恢复或长期 memory。
- TUI vNext 采用蓝白色调、顶部持续带颜色填充的小猫标识、横向分隔线和无左右大边框布局。
- Transcript 不显示固定 `You` / `AgentCode` 发言人标签；用户提示词左侧用蓝色竖杠区分，assistant streaming 时显示简短运行状态和动态 spinner。
- 工具 activity 只显示简短安全状态（例如 `Using read_file`），不得展示原始工具 JSON、stdout/stderr、stack trace 或 secret；未知/恶意工具名应显示为泛化 `tool`。
- `ui.show_thinking=false` 时 thinking 文本不得出现在 TUI、stdout/stderr、tmux/psmux pane capture 或测试输出中。

## 底线规则

- 发现旧架构不合适时，该重构就重构。不要为了兼容旧接口写出屎山代码。
- 不要一直"兼容兼容"——干净的设计比向后兼容重要。旧接口该改就改，TUI 和上层跟着适配。
- 不设"兜底兼容层"。如果新设计更好，直接替换旧实现，不保留过渡代码。

## 推荐工作方式

实现功能前：

1. 先检查现有文件和文档，尤其是 `docs/task01/claude-code-implementation-research.md`。
2. 如果功能会影响架构，先产出或更新简短的 spec/plan/checklist，再开始编码。
3. 优先做小而可验证的改动。
4. 不要修改无关的用户自建文件。
5. 不要假设不存在的项目脚本或依赖；必须先检查 manifest。

实现功能后：

1. 在相关自动化检查存在后，运行对应检查。
2. 使用 psmux 做端到端测试：
   - 优先运行 `npm run e2e:tmux`；
   - 该脚本会打包当前项目、安装到临时项目、启动真实 `agentcode` bin、输入两轮真实对话，触发 mock OpenAI 工具调用读取 fixture，并检查流式输出、上下文、工具最终回答和 API key 不泄露；
   - Windows 环境优先安装并使用 psmux；psmux 安装后提供 `psmux`、`pmux` 和 `tmux` 兼容命令，现有脚本名和部分路径暂可沿用 `tmux` 命名；
   - 如果 psmux/tmux 兼容命令不可用，必须明确记录为环境阻塞，不要声称 E2E 已通过；
   - 如果存在 `checklist.md`，按清单逐项验收。
3. 在任务记录或文档中记录验证证据。

## 踩坑记录

以下是开发过程中遇到的问题和解决方案，遇到类似问题时直接参考：

### tsx 在 Git Bash 后台进程中 stdout 被吞

- **现象：** `npx tsx script.ts > file &` 在后台运行时 stdout 为空，URL file 永远不写入
- **根因：** `npx tsx` 在 Git Bash 背景进程中的 stdout 管道有问题
- **解决：** 改用 `node --import tsx/esm script.ts`

### exactOptionalPropertyTypes 导致 undefined 赋值报错

- **现象：** `Type 'AbortSignal | undefined' is not assignable to type 'AbortSignal'`
- **根因：** tsconfig 开启了 `exactOptionalPropertyTypes`，可选字段不能直接赋 undefined
- **解决：** 使用 spread 模式：`...(signal !== undefined ? { signal } : {})`

### 扩展接口导致所有 mock 实现编译报错

- **现象：** 给 `ToolRegistry` 加了 `filterByRisk()` 后，所有测试中手写的 mock registry 都报缺少属性
- **教训：** 修改公共接口后必须立刻全局搜索所有 mock/stub 实现并同步更新
- **快速定位：** `npx tsc --noEmit` 会一次性列出所有缺失点

### ToolJsonSchemaProperty 不支持 array 类型

- **现象：** `submit_plan` 需要 array schema 但类型系统不允许
- **解决：** 扩展了 `ToolJsonSchemaProperty` 联合类型，增加 `{ type: 'array'; items: ... }` 分支
- **教训：** schema 类型系统要预留扩展空间

### 文件系统测试在并行运行时 flaky

- **现象：** `write-file.test.ts`、`run-command.test.ts`、`edit-file.test.ts` 全量运行时偶尔失败，单独运行通过
- **根因：** 文件系统操作有时间竞争，或 timeout 测试对系统负载敏感
- **处理：** 这些不是逻辑 bug；单独验证通过即可，全量运行的偶尔失败可忽略

## 架构方向

本项目目标是实现一个终端 AI 编程助手。根据当前研究文档，可能包含以下高层模块：

- CLI/session runtime；
- model-driven agent loop；
- tool execution layer；
- permission and safety boundary；
- project memory/context loading；
- terminal interaction and end-to-end testing harness。

这些只是当前架构方向，并不代表仓库中已经存在对应实现。引用具体路径、命令或模块前，必须先检查当前文件状态。
