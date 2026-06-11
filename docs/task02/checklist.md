# AgentCode 纯对话 TUI 首版 Checklist

> 每一项都必须通过运行代码、观察终端行为、检查请求体或审查实现边界来验证，聚焦系统行为而不是实现细节。

## 审查来源

- spec.md 验收标准：AC1-AC11 已由单元测试、集成测试、tmux E2E、打包安装验证和代码审查覆盖。
- plan.md 风险与回滚：已覆盖配置回退、API key 泄露、SSE 伪流式、协议兼容、thinking 泄露、上下文污染和范围膨胀风险。
- tasks.md 验证方式：已覆盖 T1-T10 的脚手架、配置、Provider、Session、TUI、bootstrap、tmux E2E 和最终验证要求。
- T10 最终验证执行于 2026-06-11：`npm run typecheck`、`npm test`、`npm run build`、`npm pack --dry-run`、`npm run e2e:tmux` 均通过。
- 子代理发现处理：T9/T10 审查发现已处理并重新验证；最终审查未发现阻塞完成的问题。原始审查报告不写入本文档。

## 实现完整性

- [x] `package.json` 定义真实可用的 `bin.agentcode`，`npm run build` 后可通过 `agentcode` 或等价本地命令启动 CLI。（验证：运行 `npm run build` 后执行构建产物，看到 AgentCode 启动入口）
- [x] `package.json` 中的 `dev`、`build`、`typecheck`、`test`、`test:run` 脚本真实存在且可运行。（验证：逐个运行脚本，记录结果）
- [x] `CLAUDE.md` 的常用命令只包含 `package.json` 中真实存在且可运行的命令。（验证：对照 `package.json` 检查并运行命令）
- [x] 项目实现了 CLI 启动层、配置层、会话应用层、Provider 适配层、TUI 适配层和测试辅助层。（验证：检查文件结构并运行 typecheck）
- [x] 源码中没有实现 tool executor、文件编辑器、shell 执行器、MCP 客户端、plugin/hook/skill/subagent runtime。（验证：代码审查和关键词搜索，确认 task02 未引入超范围模块）

## 配置与安全

- [x] 项目配置发现从当前工作目录向上查找最近的 `.agentcode/config.yaml`。（验证：在子目录运行配置加载测试，期望使用上级项目配置）
- [x] 项目 `.agentcode/config.yaml` 存在时优先使用项目配置。（验证：项目配置和全局配置同时存在，状态栏或测试断言显示 source 为 `project`）
- [x] 项目配置不存在且 `~/.agentcode/config.yaml` 存在时使用全局配置。（验证：移除项目配置，保留全局配置，状态栏或测试断言显示 source 为 `global`）
- [x] 项目配置存在但非法时直接失败，不回退到全局配置。（验证：项目配置非法、全局配置合法时启动，期望显示项目配置错误）
- [x] 缺少 `protocol`、`model`、`base_url`、`api_key` 任一字段时，在发起网络请求前失败并显示可理解错误。（验证：逐个缺字段运行配置测试）
- [x] 非法 `protocol` 和非法 `base_url` 在发起网络请求前失败并显示可理解错误。（验证：运行配置 schema 测试）
- [x] YAML 原始字段 `base_url`、`api_key`、`budget_tokens`、`show_thinking` 被归一化为运行时字段 `baseUrl`、`apiKey`、`budgetTokens`、`showThinking`。（验证：配置单元测试断言 `AgentConfig`）
- [x] 自定义 `request.headers` 不能覆盖或绕过 `api_key` 认证来源；认证只来自 `api_key` 字段。（验证：配置或 Provider 测试传入认证头，期望被拒绝或明确覆盖）
- [x] 仓库不提交真实 `.agentcode/config.yaml`、真实 API key 或可用密钥示例。（验证：搜索仓库中的 key 模式，文档示例仅使用占位符）
- [x] 配置错误、Provider 非 2xx、协议解析失败、网络失败、顶层未捕获错误、stdout/stderr、TUI pane 捕获和测试快照都不包含完整 API key 或 Authorization header。（验证：使用 sentinel key 触发错误并扫描全部输出）

## Provider 与流式协议

- [x] `protocol: openai` 创建 OpenAI Provider，`protocol: anthropic` 创建 Anthropic Provider，未知协议返回可理解错误且不启动 TUI。（验证：Provider factory 测试）
- [x] OpenAI Provider 使用 Chat Completions streaming，请求体包含配置模型、完整已完成历史和 `stream: true`。（验证：Mock SSE Server 捕获请求体）
- [x] Anthropic Provider 使用 Messages streaming，请求体包含配置模型、完整已完成历史和流式参数。（验证：Mock SSE Server 捕获请求体）
- [x] Anthropic 和 OpenAI 的实际请求主机与路径来自配置中的 `base_url`，不写死官方 API 地址。（验证：使用第三方样式 `base_url` 运行集成测试）
- [x] endpoint 拼接覆盖尾部有/无 `/`、已包含 `/v1`、带代理前缀路径等情况，最终 URL 不重复、不丢段。（验证：endpoint 单元测试）
- [x] SSE reader 覆盖 chunk 边界切开 `data:` 行、多个 event、keepalive/comment、完成标记、错误帧和最后一个 delta 不丢失。（验证：运行 `tests/unit/providers/sse.test.ts`）
- [x] OpenAI SSE 中的 `delta.content` 被转换为连续 `content.delta`，`[DONE]` 后产生完成事件。（验证：OpenAI streaming 集成测试）
- [x] Anthropic 文本 delta 被转换为 `content.delta`，thinking 事件被转换为 `thinking.delta` 且不混入 `content.delta`。（验证：Anthropic streaming 集成测试）
- [x] 401/403、429、5xx、无响应、超时、中途断流、非法 SSE 帧都映射为稳定 `PublicError`，UI 不直接显示原始厂商 JSON/HTML 错误页。（验证：Provider 错误路径测试）

## 会话与上下文

- [x] 第一轮成功完成后，第二轮 ProviderRequest 按顺序包含第一轮 user、第一轮已完成 assistant、第二轮 user。（验证：FakeProvider 记录请求历史）
- [x] assistant 回复只有在收到 `response.complete` 后才提交到 transcript。（验证：会话单元测试检查完成前历史不包含 assistant）
- [x] Provider 抛错、SSE 中途断流或协议错误时，未完成 assistant draft 被丢弃，不进入下一轮上下文。（验证：失败/中断会话测试）
- [x] 失败时已完成历史保留，本轮 user message 保留，界面显示可理解错误。（验证：会话和 TUI 集成测试）
- [x] streaming 期间再次提交输入会被明确阻止，不会启动第二个 Provider stream。（验证：并发提交测试）
- [x] Provider 抽象允许新增协议后端而不改写 TUI 对话流程。（验证：用 FakeProvider 驱动 TUI/Session 测试，TUI 不 import OpenAI/Anthropic 具体类型）

## Extended Thinking

- [x] 只有 `protocol=anthropic` 且 `thinking.enabled=true` 时，才向请求体传递 extended thinking 参数。（验证：Anthropic 请求体测试，OpenAI 请求体不包含 thinking 参数）
- [x] 收到 `thinking.delta` 时，默认 TUI、stdout/stderr、tmux pane 捕获中都不显示 thinking 文本。（验证：Anthropic thinking 集成测试和 tmux 输出扫描）
- [x] thinking 文本不写入 `messages`/transcript，不出现在第二轮 ProviderRequest 中，也不混入 `content.delta`。（验证：两轮对话测试并捕获第二轮请求体）
- [x] 流式失败时，已收到的 thinking draft 和 visible draft 都被丢弃；错误信息不带出 thinking 内容。（验证：中断流测试）

## TUI 与用户可见行为

- [x] 执行 `agentcode` 后进入交互式界面，界面至少包含输入区、对话展示区、状态信息。（验证：手动运行或 CLI/TUI 集成测试）
- [x] 状态栏可观察当前模型、配置来源和 streaming/error 状态。（验证：TUI 集成测试或 tmux capture）
- [x] 用户输入问题并提交后，用户消息出现在对话区，输入区清空或回到可继续输入状态。（验证：TUI 集成测试）
- [x] AI 回复在多个 SSE chunk 到达期间逐段显示，不是完整响应结束后一次性显示。（验证：分阶段 capture TUI/tmux 输出）
- [x] 配置错误、网络错误、认证错误、限流错误、协议错误在界面上可区分到足够帮助用户修复的程度。（验证：错误场景测试）
- [x] 无配置启动时显示“缺少配置/如何放置配置”的可理解信息，不打印原始 stack trace 或完整配置对象。（验证：无配置启动 CLI）
- [x] 项目级运行相关文件只要求放在 `.agentcode/` 目录下，不要求在项目根目录放置零散 AgentCode 专用配置文件。（验证：E2E 临时项目只写入 `.agentcode/config.yaml`）

## 范围边界

- [x] 发往模型的请求体不包含 `tools`、`tool_choice`、`functions`、`function_call`、MCP/plugin/hook/skill/subagent 相关字段。（验证：Mock SSE Server 捕获请求体）
- [x] 运行时主路径不调用 `child_process`/`spawn`/`exec` 或 shell 执行逻辑。（验证：代码审查和测试 mock，如被调用则失败）
- [x] 除配置加载读取 `.agentcode/config.yaml`/`~/.agentcode/config.yaml` 外，首版不读取、编辑或写入用户项目文件。（验证：代码审查和 E2E 前后文件树对比）
- [x] 诱导型提示词要求“读取本地文件”或“执行命令”时，AgentCode 只返回文本，不产生文件变化、子进程启动或命令执行痕迹。（验证：E2E 场景 + 文件树/进程行为观察）
- [x] 首版不实现长期记忆；关闭并重新启动后，不自动恢复上次会话内容。（验证：运行两次 CLI，第二次无上一轮 transcript）

## 编译与测试

- [x] TypeScript typecheck 通过。（验证：运行 `npm run typecheck`）
- [x] 单元测试全部通过。（验证：运行 `npm test -- tests/unit`）
- [x] Provider streaming 集成测试全部通过。（验证：运行 `npm test -- tests/integration/streaming`）
- [x] CLI/TUI 集成测试通过。（验证：运行 `npm test -- tests/integration/cli`）
- [x] 全量测试通过。（验证：运行 `npm test`）
- [x] 构建通过，产物包含可执行 CLI 入口。（验证：运行 `npm run build` 并检查 `dist/cli/main.js` 入口；`npm pack --dry-run` 确认 tarball 包含该文件）
- [x] 如存在 lint 脚本，lint 检查通过；如不存在，不声称已运行 lint。（验证：检查 `package.json` 后运行真实脚本）

## 端到端场景

- [x] 场景 1：临时项目仅包含 `.agentcode/config.yaml`，启动 `agentcode`，输入“你好，请用一句话介绍你自己”，观察回复逐段显示。（验证：tmux capture 多次截图/文本，内容逐步增长）
- [x] 场景 2：第一轮要求“记住暗号是 blue-river”，第二轮问“刚才的暗号是什么”，AI 回复包含 `blue-river`。（验证：tmux 或集成测试观察回复，并捕获第二轮请求体包含第一轮历史）
- [x] 场景 3：使用 OpenAI 协议 Mock SSE Server，配置第三方样式 `base_url`，观察流式回复成功。（验证：E2E 或集成测试通过）
- [x] 场景 4：使用 Anthropic 协议 Mock SSE Server，启用 thinking，观察最终回答显示但 thinking 文本不显示。（验证：E2E 或集成测试通过，输出扫描无 thinking sentinel）
- [x] 场景 5：项目配置非法、全局配置合法，启动失败并显示项目配置错误，不回退全局。（验证：E2E 或配置集成测试）
- [x] 场景 6：提示模型“读取本地文件并执行命令”，AgentCode 只产生文本回复，不读取/编辑项目文件，不启动 shell。（验证：E2E 前后文件树和子进程行为检查）

## 最终验收报告要求

- [x] 验收报告记录 `npm run typecheck`、`npm test`、`npm run build`、E2E 脚本的实际输出摘要。（验证：报告中包含命令、结果和关键证据）
- [x] 如果 tmux 不可用，明确记录为环境阻塞，不标记 tmux E2E 已通过。（验证：报告中说明缺失环境和可复现步骤）
- [x] 若任何 checklist 条目未通过，先修复并重新验证；不得把未通过条目标记为完成。（验证：最终报告逐项列出通过/未通过）

## 最终验收记录（2026-06-11）

### 自动化验证

- `npm run typecheck`：通过，TypeScript 全项目类型检查无错误。
- `npm test`：通过，10 个测试文件、120 个测试全部通过。
- `npm run build`：通过，`tsc -p tsconfig.build.json` 成功生成 `dist/`。
- `npm pack --dry-run`：通过，tarball 内容收敛为 `dist/` 与 `package.json`，包含 `dist/cli/main.js`。
- `npm run e2e:tmux`：通过，脚本完成构建、`npm pack`、临时项目安装、真实 `agentcode` bin 启动、tmux 输入、流式输出、第二轮上下文和 sentinel API key 不泄露检查。

### 关键 E2E 证据

- E2E 使用 `tests/helpers/mockSseCli.ts` 启动本地 Mock SSE server，并通过 `.agentcode/config.yaml` 配置 OpenAI-compatible `base_url`。
- E2E 从 `npm pack` 生成的 tarball 安装 AgentCode，执行临时项目中的 `./node_modules/.bin/agentcode`，覆盖 package `bin`、shebang、symlink/realpath 入口判断和构建产物。
- E2E 在 tmux pane 中输入 `hello from tmux`，先观察到部分文本 `first`，并断言此时尚未出现完整 `first answer`，覆盖伪流式风险。
- E2E 第二轮输入 `second question`，Mock SSE server 只有在请求体包含上一轮 assistant 文本 `first answer` 时才返回 `I remember first answer.`，覆盖当前会话上下文。
- E2E 在轮询阶段检查原始 tmux pane 内容、在结束前检查最终 pane 内容；pane snapshot log 是已脱敏诊断产物，并额外断言不会持久化完整 sentinel API key。失败诊断会先脱敏再输出。

### 范围与安全检查

- `src/` 关键词搜索未发现 `child_process`、`spawn`、`exec`、tool use、MCP/plugin/hook/skill/subagent runtime 相关实现。
- 首版运行主路径只实现纯对话 TUI、配置加载、Provider streaming、会话上下文和错误展示；未加入文件编辑、shell 执行、MCP、插件、长期记忆或权限系统。
- 当前 `package.json` 没有 lint 脚本，因此未运行 lint，也不声称 lint 已通过。
- tmux 在当前环境可用，未发生环境阻塞。
