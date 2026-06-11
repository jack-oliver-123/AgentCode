# AgentCode 纯对话 TUI 首版 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `package.json` | npm scripts、依赖声明、`agentcode` bin 入口 |
| 新建 | `package-lock.json` | npm 依赖锁定文件 |
| 新建 | `tsconfig.json` | TypeScript 编译配置 |
| 新建 | `vitest.config.ts` | Vitest 测试配置 |
| 新建 | `src/cli/main.ts` | CLI 启动入口 |
| 新建 | `src/app/bootstrapApp.ts` | 应用装配入口 |
| 新建 | `src/config/loadConfig.ts` | 配置发现、读取、解析和加载 |
| 新建 | `src/config/schema.ts` | `RawConfig` 到 `AgentConfig` 的校验与归一化 |
| 新建 | `src/config/redact.ts` | API key 和错误信息脱敏 |
| 新建 | `src/session/types.ts` | 会话状态、消息和事件类型 |
| 新建 | `src/session/ChatSessionController.ts` | 多轮会话和流式 turn 管理 |
| 新建 | `src/providers/types.ts` | Provider 统一接口和事件类型 |
| 新建 | `src/providers/createProvider.ts` | Provider factory |
| 新建 | `src/providers/shared/endpoint.ts` | `base_url` 与 endpoint 拼接 |
| 新建 | `src/providers/shared/fetchTransport.ts` | HTTP 请求、超时和状态码处理 |
| 新建 | `src/providers/shared/sse.ts` | SSE 流解析 |
| 新建 | `src/providers/shared/errors.ts` | Provider 错误映射 |
| 新建 | `src/providers/openai/OpenAIProvider.ts` | OpenAI Chat Completions 流式适配 |
| 新建 | `src/providers/anthropic/AnthropicProvider.ts` | Anthropic Messages 流式适配和 thinking 解析 |
| 新建 | `src/tui/App.tsx` | Ink TUI 根组件 |
| 新建 | `src/tui/components/TranscriptPane.tsx` | 对话历史展示 |
| 新建 | `src/tui/components/InputPane.tsx` | 输入区 |
| 新建 | `src/tui/components/StatusBar.tsx` | 模型、配置来源和状态展示 |
| 新建 | `src/tui/useChatController.ts` | TUI 与会话控制器桥接 |
| 新建 | `src/shared/errors.ts` | 通用错误类型和格式化 |
| 新建 | `src/shared/ids.ts` | ID 生成 |
| 新建 | `tests/helpers/FakeProvider.ts` | 会话和 TUI 测试用 Provider 替身 |
| 新建 | `tests/helpers/createMockSseServer.ts` | Provider 集成测试用 Mock SSE Server |
| 新建 | `tests/helpers/tempConfig.ts` | 临时项目/全局配置目录辅助函数 |
| 新建 | `tests/helpers/captureOutput.ts` | stdout/stderr 输出捕获和密钥泄露扫描 |
| 新建 | `tests/unit/config/loadConfig.test.ts` | 配置发现、优先级、非法配置测试 |
| 新建 | `tests/unit/config/redact.test.ts` | API key 脱敏测试 |
| 新建 | `tests/unit/session/ChatSessionController.test.ts` | 多轮上下文、draft、thinking 隐藏和失败回滚测试 |
| 新建 | `tests/unit/providers/sse.test.ts` | SSE chunk、keepalive、完成和错误解析测试 |
| 新建 | `tests/integration/streaming/openai.test.ts` | OpenAI 协议流式集成测试 |
| 新建 | `tests/integration/streaming/anthropic.test.ts` | Anthropic 协议流式和 thinking 集成测试 |
| 新建 | `tests/integration/cli/cli.test.tsx` | CLI 启动、配置错误和基础交互测试 |
| 新建 | `tests/e2e/tmux/agentcode-smoke.sh` | tmux 端到端验收脚本 |
| 修改 | `CLAUDE.md` | 项目 scaffold 后补充真实命令 |
| 新建 | `docs/task02/tasks.md` | 本任务拆解文档 |
| 后续新建 | `docs/task02/checklist.md` | 阶段四验收清单 |

## T1: 初始化 TypeScript CLI 脚手架

**文件：** `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `src/cli/main.ts`

**依赖：** 无

**步骤：**
1. 初始化 npm/TypeScript 项目，声明 ESM 运行方式和 Node.js 20+ 约束。
2. 添加 `agentcode` bin 入口，指向构建后的 CLI 文件。
3. 添加真实脚本：`dev`、`build`、`typecheck`、`test`、`test:run`，不添加无法工作的占位脚本。
4. 添加首版依赖：Ink/React、YAML 解析、schema 校验、SSE 解析、测试框架和 TypeScript 工具链。
5. 创建最小 `src/cli/main.ts`，只负责调用后续 bootstrap；未实现模块可先保留可测试的错误出口。

**验证：**
- 运行 `npm install` 成功生成 `package-lock.json`。
- 运行 `npm run typecheck`，期望 TypeScript 配置可被识别。
- 运行 `npm test`，期望测试框架可启动，即使暂时没有业务测试也不能报配置错误。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：脚手架/依赖正确性、CLI/bin 可维护性、测试脚本与跨平台风险。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T2: 实现配置 schema、发现顺序和脱敏

**文件：** `src/config/loadConfig.ts`, `src/config/schema.ts`, `src/config/redact.ts`, `src/shared/errors.ts`, `tests/unit/config/loadConfig.test.ts`, `tests/unit/config/redact.test.ts`, `tests/helpers/tempConfig.ts`

**依赖：** T1

**步骤：**
1. 定义 `RawConfig`、`AgentConfig`、`ResolvedConfig` 和 `ProviderProtocol`。
2. 实现从当前工作目录向上查找最近 `.agentcode/config.yaml` 的项目配置发现逻辑。
3. 项目配置不存在时，回退到 `~/.agentcode/config.yaml`。
4. 项目配置存在但非法时直接报错，不回退到全局配置。
5. 校验必填字段 `protocol`、`model`、`base_url`、`api_key`，并归一化到 `baseUrl`、`apiKey`、`budgetTokens`、`showThinking`。
6. 实现 API key 脱敏，所有配置错误和可展示错误不得包含完整 key。
7. 补充配置优先级、缺字段、非法 protocol、非法 URL、项目非法不回退、脱敏输出测试。

**验证：**
- 运行 `npm test -- tests/unit/config`，期望全部通过。
- 人工检查测试用 sentinel API key 不出现在失败输出、错误消息和快照中。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：配置优先级正确性、安全/密钥泄露风险、schema 与 spec/plan 一致性。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T3: 实现 Provider 共享类型、endpoint、fetch transport 和 SSE reader

**文件：** `src/providers/types.ts`, `src/providers/shared/endpoint.ts`, `src/providers/shared/fetchTransport.ts`, `src/providers/shared/sse.ts`, `src/providers/shared/errors.ts`, `tests/unit/providers/sse.test.ts`

**依赖：** T1, T2

**步骤：**
1. 定义 `ProviderRequest`、`ProviderEvent`、`ChatModelProvider`、`PublicError` 等 Provider 边界类型。
2. 实现 `baseUrl` 与协议 endpoint 的安全拼接，覆盖尾部斜杠、已带 `/v1`、代理前缀路径等情况。
3. 实现 fetch transport：请求头构造、超时/AbortSignal、非 2xx 状态码映射。
4. 实现独立 SSE reader，支持 chunk 边界、多个 event 合并、keepalive 注释、完成标记和错误帧。
5. 补充 SSE 单元测试，验证不会吞掉最后一个 delta，不会把完整响应攒完才输出。

**验证：**
- 运行 `npm test -- tests/unit/providers/sse.test.ts`，期望全部通过。
- 运行 `npm run typecheck`，期望 Provider 类型边界无错误。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：SSE 正确性/边界条件、错误处理与重试语义、第三方 `base_url` 兼容风险。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T4: 实现 OpenAI Chat Completions Provider

**文件：** `src/providers/openai/OpenAIProvider.ts`, `src/providers/createProvider.ts`, `tests/integration/streaming/openai.test.ts`, `tests/helpers/createMockSseServer.ts`

**依赖：** T3

**步骤：**
1. 实现 OpenAI Chat Completions streaming 请求构造。
2. 将 `ChatMessage` 转换为 OpenAI `messages` 格式，只发送可见 text transcript。
3. 从 OpenAI 兼容 SSE 中解析 `delta.content`，输出统一 `content.delta`。
4. 正确处理 `[DONE]`、非 2xx、协议错误和中途断流。
5. 用 Mock SSE Server 验证逐段输出、endpoint 拼接、请求模型和历史消息。

**验证：**
- 运行 `npm test -- tests/integration/streaming/openai.test.ts`，期望全部通过。
- 测试中使用第三方样式 `base_url`，确认 Provider 不写死官方地址。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：OpenAI 协议兼容性、Provider 抽象边界、网络/错误路径安全性。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T5: 实现 Anthropic Messages Provider 和 extended thinking 隐藏流

**文件：** `src/providers/anthropic/AnthropicProvider.ts`, `src/providers/createProvider.ts`, `tests/integration/streaming/anthropic.test.ts`

**依赖：** T3, T4

**步骤：**
1. 实现 Anthropic Messages streaming 请求构造。
2. 将 `ChatMessage` 转换为 Anthropic messages，只发送可见 text transcript。
3. 当配置启用 thinking 且 Provider 支持时，传递 extended thinking 相关请求参数。
4. 解析 Anthropic 文本 delta 为 `content.delta`。
5. 解析 thinking 相关事件为 `thinking.delta`，但不混入 `content.delta`。
6. 测试 thinking 默认不进入可见 transcript，也不带入下一轮请求。

**验证：**
- 运行 `npm test -- tests/integration/streaming/anthropic.test.ts`，期望全部通过。
- 断言 thinking 文本不会出现在可见回复、历史消息和下一轮 ProviderRequest 中。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：Anthropic 协议/extended thinking 正确性、thinking 泄露风险、与 OpenAI Provider 的统一接口一致性。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T6: 实现 ChatSessionController 和 FakeProvider 测试

**文件：** `src/session/types.ts`, `src/session/ChatSessionController.ts`, `src/shared/ids.ts`, `tests/helpers/FakeProvider.ts`, `tests/unit/session/ChatSessionController.test.ts`

**依赖：** T3

**步骤：**
1. 实现当前进程内 transcript 管理。
2. 用户提交后立即追加 user message。
3. 调用 Provider 并把 `content.delta` 累积到 assistant draft。
4. 将 `thinking.delta` 只保存在当前 draft 的隐藏字段中，默认不写入 transcript。
5. 只有 `response.complete` 后才提交 assistant 可见文本到历史。
6. Provider 出错或中断时丢弃 assistant draft，保留已完成历史和本轮 user message。
7. 使用 FakeProvider 测试多轮上下文、thinking 隐藏、失败不污染历史、streaming 时禁止并发提交。

**验证：**
- 运行 `npm test -- tests/unit/session/ChatSessionController.test.ts`，期望全部通过。
- 运行 `npm run typecheck`，期望会话类型无错误。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：多轮上下文正确性、失败/中断回滚规则、thinking 和并发状态风险。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T7: 实现 Ink TUI 核心交互

**文件：** `src/tui/App.tsx`, `src/tui/useChatController.ts`, `src/tui/components/TranscriptPane.tsx`, `src/tui/components/InputPane.tsx`, `src/tui/components/StatusBar.tsx`, `tests/integration/cli/cli.test.tsx`

**依赖：** T6

**步骤：**
1. 实现 TUI 根组件，展示标题、状态栏、对话历史、assistant draft 和输入区。
2. 输入提交后调用 `ChatSessionController.submitUserText`。
3. 流式期间增量展示 assistant 可见文本。
4. 默认隐藏 thinking 内容，即使 controller 收到 thinking draft 也不展示。
5. streaming 时禁止再次提交，避免多个流同时写入 UI。
6. 配置来源和当前模型在状态栏中可观察显示。
7. 添加基础 CLI/TUI 集成测试，使用 FakeProvider 验证输入、流式展示、错误展示。

**验证：**
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`，期望全部通过。
- 手动运行本地 dev 命令，确认 TUI 能启动并显示输入区；若还未接真实 Provider，可使用测试入口或 FakeProvider 模式验证 UI。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：TUI 交互正确性、状态管理/流式渲染稳定性、可访问性和跨平台终端风险。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T8: 接通 bootstrap、CLI 入口和真实 Provider factory

**文件：** `src/app/bootstrapApp.ts`, `src/cli/main.ts`, `src/providers/createProvider.ts`, `tests/integration/cli/cli.test.tsx`

**依赖：** T2, T4, T5, T6, T7

**步骤：**
1. 在 bootstrap 中加载配置、创建 Provider、创建 ChatSessionController、启动 TUI。
2. CLI 入口调用 bootstrap，并处理顶层 PublicError。
3. Provider factory 根据 `protocol` 返回 OpenAI 或 Anthropic Provider。
4. 顶层错误输出必须脱敏，并给出用户可理解的配置/网络/协议错误。
5. 集成测试覆盖缺配置、非法配置、protocol 切换和 Provider factory 分支。

**验证：**
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`，期望全部通过。
- 运行 `npm run build`，期望产物包含可执行 CLI 入口。
- 运行 `node dist/cli/main.js` 或等价本地命令，在无配置时显示可理解错误且不泄露 key。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：启动装配正确性、错误出口/脱敏安全性、Provider factory 与配置协议映射。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T9: 补齐端到端 tmux 验收脚本

**文件：** `tests/e2e/tmux/agentcode-smoke.sh`, `tests/helpers/createMockSseServer.ts`, `tests/helpers/tempConfig.ts`, `tests/helpers/captureOutput.ts`, `package.json`

**依赖：** T8

**步骤：**
1. 编写 Mock SSE Server 启动方式，支持 OpenAI 和 Anthropic 两类流式 fixture。
2. 编写 tmux 脚本：创建临时项目目录、写入 `.agentcode/config.yaml`、启动 `agentcode`。
3. 使用 tmux `send-keys` 输入第一轮真实问题。
4. 分阶段 `capture-pane`，验证回复是增量出现，不是结束后一次性出现。
5. 输入第二轮问题，验证上下文记忆。
6. 验证 pane 输出不包含完整 sentinel API key。
7. 在 `package.json` 增加可运行的 e2e 脚本。

**验证：**
- 运行对应 e2e 脚本，期望 tmux 场景通过。
- 若当前环境缺少 tmux，记录为环境阻塞，不得声称 E2E 已通过；保留脚本和可复现说明。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：E2E 场景覆盖度、tmux 脚本可移植性、API key 泄露和伪流式验证可靠性。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T10: 更新项目命令文档和最终验证

**文件：** `CLAUDE.md`, `docs/task02/tasks.md`, `docs/task02/checklist.md`（如已生成）, `package.json`

**依赖：** T1-T9

**步骤：**
1. 根据真实 `package.json` 更新 `CLAUDE.md` 的常用命令，不编造不存在的命令。
2. 确认 `docs/task02/spec.md`、`docs/task02/plan.md`、`docs/task02/tasks.md` 与实际实现没有明显冲突。
3. 运行完整验证：typecheck、unit tests、integration tests、build、tmux e2e（如环境可用）。
4. 汇总验证证据，包括命令、关键输出和未执行项原因。
5. 检查首版没有引入 tool use、文件编辑、shell 执行能力的业务模块。

**验证：**
- 运行 `npm run typecheck`，期望通过。
- 运行 `npm test`，期望通过。
- 运行 `npm run build`，期望通过。
- 运行 e2e 脚本，期望通过；如 tmux 不可用，明确记录环境限制。

**任务后审查：** 验证通过后，启动至少 3 个只读子代理审查本任务相关变更；角度分别为：文档与实际命令一致性、整体功能回归/范围控制、安全和配置风险。若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## 执行顺序

```text
T1 脚手架
  -> T2 配置层
  -> T3 Provider 共享层
      ├── T4 OpenAI Provider
      └── T5 Anthropic Provider
  -> T6 会话控制器
  -> T7 TUI
  -> T8 bootstrap/CLI 接通
  -> T9 tmux E2E
  -> T10 文档与最终验证
```

T4 和 T5 都依赖 T3，理论上可并行；但首次实现建议先完成 T4，再完成 T5，以便复用 Provider 共享层和 Mock SSE Server 经验。
