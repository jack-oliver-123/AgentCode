# Tool System Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/tools/types.ts` | 定义工具系统公共类型：工具定义、注册中心、执行上下文、结果、错误、Provider 工具声明和工具调用。 |
| 新建 | `src/tools/schemas.ts` | 定义 JSON Schema helper 和六个内置工具的输入 schema。 |
| 新建 | `src/tools/registry.ts` | 实现默认工具注册中心，集中登记六个内置工具并导出 Provider 工具声明。 |
| 新建 | `src/tools/executor.ts` | 实现统一工具执行入口，处理 JSON parse、未知工具、参数校验、超时、异常捕获和 redaction。 |
| 新建 | `src/tools/workspace.ts` | 实现 workspace 路径解析、相对路径输出、越界和 symlink/junction 防护。 |
| 新建 | `src/tools/redaction.ts` | 实现工具结果递归 redaction，复用现有 secret redaction 规则。 |
| 新建 | `src/tools/builtins/read-file.ts` | 实现 `read_file` 工具。 |
| 新建 | `src/tools/builtins/write-file.ts` | 实现 `write_file` 工具。 |
| 新建 | `src/tools/builtins/edit-file.ts` | 实现 `edit_file` 工具。 |
| 新建 | `src/tools/builtins/run-command.ts` | 实现 `run_command` 工具。 |
| 新建 | `src/tools/builtins/glob-files.ts` | 实现 `glob_files` 工具。 |
| 新建 | `src/tools/builtins/search-code.ts` | 实现 `search_code` 工具。 |
| 新建 | `src/tools/builtins/index.ts` | 统一导出六个 built-in 工具 factory。 |
| 修改 | `src/providers/types.ts` | 扩展 Provider request/event/message 类型，支持工具声明、工具调用和工具结果回灌。 |
| 修改 | `src/providers/openai/OpenAIProvider.ts` | 增加 OpenAI-compatible 工具声明映射和流式 tool call 解析。 |
| 修改 | `src/providers/anthropic/AnthropicProvider.ts` | 增加 Anthropic 工具声明映射和流式 `tool_use` 解析。 |
| 修改 | `src/session/types.ts` | 扩展 draft activity 和必要的 session/message 类型。 |
| 修改 | `src/session/ChatSessionController.ts` | 编排首轮模型请求、一次工具执行、工具结果回灌和最终回答。 |
| 修改 | `src/app/bootstrapApp.tsx` | 创建默认工具注册中心，并把 cwd、timeout、secret 注入 Controller。 |
| 修改 | `src/tui/components/TranscriptPane.tsx` | 显示简短工具 activity，不展示原始工具 JSON。 |
| 新建 | `tests/unit/tools/*.test.ts` | 覆盖工具类型、路径安全、redaction、executor 和六个内置工具。 |
| 修改 | `tests/helpers/FakeProvider.ts` | 支持工具事件和记录多次 Provider request。 |
| 修改/新建 | `tests/integration/streaming/openai.test.ts` | 覆盖 OpenAI-compatible 工具声明和流式参数碎片解析。 |
| 修改/新建 | `tests/integration/streaming/anthropic.test.ts` | 覆盖 Anthropic 工具声明和 `input_json_delta` 拼接。 |
| 修改 | `tests/integration/cli/cli.test.tsx` | 覆盖 TUI 工具 activity、一次工具回灌和 redaction。 |
| 修改 | `tests/e2e/tmux/agentcode-smoke.sh` | 增加 mock provider 工具调用 smoke，验证最终回答和 secret 不泄漏。 |
| 修改 | `docs/task04/checklist.md` | 在验收阶段写入最终 checklist；本 tasks 阶段先不创建。 |

## T1: 建立工具类型、schema 和注册中心骨架

**文件：**
- `src/tools/types.ts`
- `src/tools/schemas.ts`
- `src/tools/registry.ts`
- `src/tools/builtins/index.ts`
- `tests/unit/tools/registry.test.ts`

**依赖：** 无

**步骤：**
1. 定义 `ToolDefinition`、`ToolRisk`、`ToolRegistry`、`ProviderToolDeclaration`、`ProviderToolCall`、`ToolExecutionContext`、`ToolExecutionResult`、`ToolExecutionError`、`ToolErrorCode` 和 `ToolJsonSchema`。
2. 定义 `ToolValidationResult<T>`，用于表达参数校验成功或失败。
3. 在 `schemas.ts` 中定义六个内置工具的输入 JSON Schema。
4. 创建六个 built-in 工具 factory 的占位导出，先返回最小可注册工具定义；真实工具行为在后续任务补齐。
5. 实现 `createDefaultToolRegistry()`，注册六个工具。
6. 添加注册中心单元测试，断言六个工具均可列出、按名查找，并能导出包含名称、描述、schema 的 Provider 声明。

**验证：**
- 运行 `npm test -- tests/unit/tools/registry.test.ts`
- 期望注册中心测试通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 正确性/回归：检查类型和 registry 行为是否满足 spec/plan。
2. 架构一致性：检查工具抽象是否过度耦合 Provider/TUI。
3. 测试/错误处理：检查 schema 和 registry 测试是否覆盖关键路径。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T2: 实现 workspace 路径安全和工具 redaction

**文件：**
- `src/tools/workspace.ts`
- `src/tools/redaction.ts`
- `tests/unit/tools/workspace.test.ts`
- `tests/unit/tools/redaction.test.ts`

**依赖：** T1

**步骤：**
1. 实现 `resolveWorkspacePath(cwd, inputPath)`，返回 workspace 内绝对路径和相对路径。
2. 处理相对路径、绝对路径、`..`、Windows 路径分隔符和大小写差异。
3. 对已存在目标使用 `realpath` 防止 symlink/junction 指向 workspace 外。
4. 对待创建文件使用父目录边界检查。
5. 实现 `redactToolValue(value, secrets)`，递归清洗字符串、数组和对象。
6. 实现 `redactToolResult(result, secrets)`，确保工具结果返回 Controller 前已被清洗。
7. 添加路径安全测试，覆盖 workspace 内路径、`../` 越界、绝对路径越界、symlink 外指向、父目录越界。
8. 添加 redaction 测试，覆盖 API key、Authorization、Bearer、JWT 和 sentinel secret。

**验证：**
- 运行 `npm test -- tests/unit/tools/workspace.test.ts tests/unit/tools/redaction.test.ts`
- 期望路径安全和 redaction 测试通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 安全：检查路径越界、symlink/junction 和 secret redaction 是否存在绕过。
2. 正确性/跨平台：检查 Windows/Linux 路径处理是否稳定。
3. 测试覆盖：检查失败路径是否有断言且不会静默放行。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T3: 实现 Tool Executor 统一执行入口

**文件：**
- `src/tools/executor.ts`
- `tests/unit/tools/executor.test.ts`

**依赖：** T1, T2

**步骤：**
1. 实现 `executeToolCall(call, registry, context)`。
2. 解析 `ProviderToolCall.argumentsText` 为 JSON；非法 JSON 返回 `invalid_arguments`。
3. 未知工具返回 `unknown_tool`。
4. 调用工具 `validate()`；校验失败返回 `invalid_arguments`。
5. 为工具执行添加 duration 统计和统一超时控制。
6. 捕获工具实现抛出的异常，转换为 `tool_internal_error`。
7. 在返回前调用 `redactToolResult()`。
8. 添加 executor 单元测试，覆盖成功执行、非法 JSON、未知工具、参数无效、工具异常、超时、redaction。

**验证：**
- 运行 `npm test -- tests/unit/tools/executor.test.ts`
- 期望 executor 测试通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 正确性：检查 executor 是否覆盖所有工具失败路径。
2. 错误处理/安全：检查异常、超时和 redaction 是否统一生效。
3. 架构一致性：检查 executor 是否避免耦合具体工具或 Provider。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T4: 实现文件类工具 read_file/write_file/edit_file

**文件：**
- `src/tools/builtins/read-file.ts`
- `src/tools/builtins/write-file.ts`
- `src/tools/builtins/edit-file.ts`
- `src/tools/builtins/index.ts`
- `tests/unit/tools/read-file.test.ts`
- `tests/unit/tools/write-file.test.ts`
- `tests/unit/tools/edit-file.test.ts`

**依赖：** T1, T2, T3

**步骤：**
1. 实现 `read_file` 参数校验和执行逻辑。
2. `read_file` 仅读取 workspace 内文本文件，返回内容、字节数和截断状态。
3. 实现 `write_file` 参数校验和执行逻辑。
4. `write_file` 默认不覆盖已有文件；覆盖必须显式传 `overwrite: true`。
5. 实现 `edit_file` 参数校验和执行逻辑。
6. `edit_file` 只在 `oldText` 唯一匹配时替换；0 次或多次匹配都不修改文件。
7. 添加单元测试覆盖成功、路径越界、目标不存在、非文本、大文件截断、默认不覆盖、显式覆盖、编辑 0 次/1 次/多次匹配。
8. 确认失败路径不会修改文件内容。

**验证：**
- 运行 `npm test -- tests/unit/tools/read-file.test.ts tests/unit/tools/write-file.test.ts tests/unit/tools/edit-file.test.ts`
- 期望三个文件类工具测试通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 正确性/数据安全：检查读写编辑行为是否符合 spec，失败时是否保持文件不变。
2. 安全：检查 workspace 边界、文本判断和覆盖策略。
3. 测试覆盖：检查边界条件和错误码是否充分断言。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T5: 实现 run_command 工具

**文件：**
- `src/tools/builtins/run-command.ts`
- `tests/unit/tools/run-command.test.ts`

**依赖：** T1, T2, T3

**步骤：**
1. 实现 `run_command` 参数校验。
2. 使用 Node 子进程能力在 workspace cwd 下执行一次性命令。
3. 支持默认 timeout 和输入 `timeoutMs`，但不得超过安全上限。
4. 捕获 stdout、stderr、exitCode、timedOut 和 truncated。
5. 区分命令成功、非零退出码、启动失败和超时。
6. 对 stdout/stderr 做输出大小限制和 redaction。
7. 添加单元测试覆盖成功命令、非零退出码、stderr、超时、输出截断、secret 输出 redaction。

**验证：**
- 运行 `npm test -- tests/unit/tools/run-command.test.ts`
- 期望命令工具测试通过且不会留下长期运行子进程。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 安全：检查命令执行边界、timeout、输出限制和 redaction。
2. 正确性/跨平台：检查 Windows/bash 环境下命令行为和退出码处理。
3. 测试/错误处理：检查超时、spawn 失败和非零退出码区分是否清楚。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T6: 实现 glob_files 和 search_code 工具

**文件：**
- `src/tools/builtins/glob-files.ts`
- `src/tools/builtins/search-code.ts`
- `tests/unit/tools/glob-files.test.ts`
- `tests/unit/tools/search-code.test.ts`

**依赖：** T1, T2, T3

**步骤：**
1. 实现受控内部 glob 子集，支持 `*`、`**`、`?`。
2. 默认跳过 `.git`、`node_modules`、`dist`。
3. `glob_files` 返回 workspace 相对路径和 truncated 状态。
4. 实现 `search_code` 参数校验，支持文本搜索和正则搜索。
5. 搜索时跳过默认排除目录，限制单文件大小、最大结果数和 preview 长度。
6. 无效正则返回 `invalid_arguments`。
7. 搜索结果 preview 做 redaction。
8. 添加单元测试覆盖 glob 匹配、默认排除、结果截断、文本搜索、正则搜索、无效正则、secret preview redaction。

**验证：**
- 运行 `npm test -- tests/unit/tools/glob-files.test.ts tests/unit/tools/search-code.test.ts`
- 期望 glob/search 工具测试通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 正确性：检查 glob 子集和 search 匹配行为是否符合文档。
2. 性能/效率：检查递归遍历、文件大小限制和结果上限是否避免大仓库失控。
3. 安全/测试：检查路径边界、默认排除和 redaction 是否覆盖。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T7: 扩展 Provider 类型和 FakeProvider 测试能力

**文件：**
- `src/providers/types.ts`
- `tests/helpers/FakeProvider.ts`
- 相关现有 provider/session 测试

**依赖：** T1

**步骤：**
1. 扩展 `ProviderRequest`，增加 `tools?: ProviderToolDeclaration[]` 和 `toolChoice?: 'auto' | 'none'`。
2. 扩展 `ProviderEvent`，增加 `{ type: 'tool.call'; call: ProviderToolCall }`。
3. 如需要，扩展 Provider message 类型以表达工具结果回灌。
4. 修改 `FakeProvider`，支持产出 `tool.call` 事件。
5. 修改 `FakeProvider` 以记录每次收到的 `ProviderRequest`，便于 session 测试断言首轮/第二轮请求差异。
6. 更新现有测试中的类型错误，确保纯文本测试不需要关心工具字段。

**验证：**
- 运行 `npm run typecheck`
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`
- 期望类型检查通过，现有 CLI/TUI 测试不因 Provider 类型扩展回退。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 类型设计：检查 Provider 类型扩展是否兼容现有纯文本路径。
2. 测试能力：检查 FakeProvider 是否足以覆盖工具回灌场景。
3. 回归风险：检查现有 Provider/Session/TUI 测试是否被不必要改写。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T8: 实现 OpenAI-compatible 工具声明和流式工具调用解析

**文件：**
- `src/providers/openai/OpenAIProvider.ts`
- `tests/integration/streaming/openai.test.ts`

**依赖：** T7

**步骤：**
1. 将 `ProviderRequest.tools` 映射为 OpenAI-compatible `tools` request body。
2. 将 `toolChoice: 'none'` 映射为 OpenAI-compatible 禁用工具选择的 request body。
3. 扩展 OpenAI stream chunk 类型，支持 `choices[0].delta.tool_calls`。
4. 在 Provider 内部按 tool call index/id 拼接 `function.arguments` 碎片。
5. 在 `finish_reason: "tool_calls"` 时产出完整 `tool.call` 事件。
6. 保持现有 `content.delta`、`response.complete`、`event: error` 行为不变。
7. 添加测试覆盖 request body 中的 tools、参数 JSON 分片、非法参数片段、多工具只接收/报告第一个、普通文本流回归。

**验证：**
- 运行 `npm test -- tests/integration/streaming/openai.test.ts`
- 期望 OpenAI streaming 测试全部通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. Provider 协议正确性：检查 request body 和 stream parsing 是否符合 OpenAI-compatible 预期。
2. 回归风险：检查普通文本、error event、finish_reason 逻辑未被破坏。
3. 边界测试：检查 JSON 参数碎片、多工具和非法事件是否覆盖。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T9: 实现 Anthropic 工具声明和流式 tool_use 解析

**文件：**
- `src/providers/anthropic/AnthropicProvider.ts`
- `tests/integration/streaming/anthropic.test.ts`

**依赖：** T7

**步骤：**
1. 将 `ProviderRequest.tools` 映射为 Anthropic Messages `tools` request body。
2. 将 `toolChoice: 'none'` 映射为不发送工具声明或 Anthropic 可接受的禁用工具策略。
3. 扩展 Anthropic stream event 类型，支持 `content_block_start` 的 `tool_use` block。
4. 支持 `content_block_delta` 中的 `input_json_delta.partial_json` 拼接。
5. 在 tool block 完成后产出完整 `tool.call` 事件。
6. 保持现有 text delta、thinking delta、message_stop 和 SSE error 行为不变。
7. 添加测试覆盖 request body 中的 tools、`input_json_delta` 分片、普通 text/thinking 回归、非法/缺失工具字段。

**验证：**
- 运行 `npm test -- tests/integration/streaming/anthropic.test.ts`
- 期望 Anthropic streaming 测试全部通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. Provider 协议正确性：检查 Anthropic tools schema 和 stream parsing。
2. 回归风险：检查 text/thinking/message_stop 行为未回退。
3. 错误处理：检查非法 JSON、缺失字段和多 block 情况是否安全。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T10: 实现 ChatSessionController 单工具闭环

**文件：**
- `src/session/types.ts`
- `src/session/ChatSessionController.ts`
- `src/app/bootstrapApp.tsx`
- `tests/unit/session/ChatSessionController.tools.test.ts`
- `tests/integration/cli/cli.test.tsx`

**依赖：** T1-T9

**步骤：**
1. 扩展 `ChatSessionControllerOptions`，支持可选 `toolRegistry`、`cwd`、`toolTimeoutMs`、`maxToolOutputBytes`、`toolSecrets`。
2. 扩展 `ChatSessionDraft` activity，用于表示工具执行状态。
3. 首轮 Provider request 在工具 registry 存在时携带 `tools` 和 `toolChoice: 'auto'`。
4. 监听首轮 `tool.call` 事件。
5. 收到第一个工具调用后，执行 `executeToolCall()`。
6. 将工具结果作为上下文回灌，并发起第二轮 Provider request。
7. 第二轮 Provider request 不暴露工具声明，或设置 `toolChoice: 'none'`。
8. 第二轮只提交最终 assistant 文本。
9. 如果第二轮仍返回 `tool.call`，不执行第二个工具，并以清晰错误或安全最终说明结束。
10. 保持无工具调用时现有纯文本会话行为不变。
11. 在 `bootstrapApp` 中创建默认工具注册中心并注入 cwd、config api key secret、timeout、输出限制。
12. 添加 session 单元测试覆盖：
    - 无工具调用纯文本回归。
    - 工具成功后第二轮最终回答。
    - 工具失败作为结果回灌。
    - 第二轮再次工具调用不会执行。
    - 工具结果和最终消息不包含 secret。
13. 扩展 CLI/TUI 集成测试，覆盖工具 activity 状态。

**验证：**
- 运行 `npm test -- tests/unit/session/ChatSessionController.tools.test.ts tests/integration/cli/cli.test.tsx`
- 运行 `npm run typecheck`
- 期望 session 工具闭环和现有 TUI 测试通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 状态机正确性：检查首轮、工具执行、第二轮、失败路径和单工具上限。
2. 架构一致性：检查 Controller 是否过度膨胀，工具执行是否仍通过 Tool Runtime。
3. 安全/回归：检查 secret、错误状态、纯文本路径和第二工具调用限制。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T11: 完善 TUI 工具活动展示

**文件：**
- `src/tui/components/TranscriptPane.tsx`
- `tests/integration/cli/cli.test.tsx`

**依赖：** T10

**步骤：**
1. 在 draft activity 为 tool 时显示简短状态，例如 `Using read_file`。
2. 保持现有 spinner 和 `Thinking` / `Writing · N chars` 展示。
3. 不直接展示工具结果 JSON、stdout/stderr 或内部错误堆栈。
4. 添加 renderToString 测试，断言工具 activity 可见且原始 secret/工具 JSON 不可见。
5. 确认 `ui.show_thinking=false` 仍不显示 thinking 文本。

**验证：**
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`
- 期望 TUI 集成测试通过。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. UI/UX：检查工具活动展示是否简洁且符合 task03 蓝白风格。
2. 安全：检查 TUI 不泄漏工具原始输出或 secret。
3. 回归：检查现有 transcript、thinking 隐藏、input disabled 行为未被破坏。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T12: 扩展 tmux/psmux E2E smoke 工具场景

**文件：**
- `tests/helpers/mockSseCli.ts`
- `tests/e2e/tmux/agentcode-smoke.sh`

**依赖：** T8, T9, T10, T11

**步骤：**
1. 扩展 mock SSE server，使其能模拟工具调用和工具结果后的最终回答。
2. 在 E2E 临时项目中准备一个可读取的 fixture 文件。
3. 第一轮 mock response 返回工具调用，例如 `read_file`，参数以多个 JSON 片段流式发送。
4. AgentCode 执行工具后，第二轮 mock response 返回最终回答，例如包含 fixture 内容摘要。
5. 保留现有两轮纯文本对话 smoke，确保上下文仍工作。
6. 增加 pane capture 断言：
   - 可见工具 activity 或最终工具回答。
   - 最终回答出现。
   - sentinel API key 不出现在 pane、pane log、stdout/stderr。
   - 第二轮不会执行额外工具。
7. 如果 tmux/psmux 不可用，脚本应明确以环境阻塞退出，不得假装通过。

**验证：**
- 运行 `npm run e2e:tmux`
- 期望 tmux/psmux E2E smoke 通过；如环境缺少 tmux/psmux，明确记录环境阻塞。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. E2E 正确性：检查 mock provider 是否真实覆盖工具闭环。
2. 安全：检查 pane capture 和 logs 是否充分验证 secret 不泄漏。
3. 稳定性：检查 E2E 是否存在时序 flake、环境依赖或假阳性。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T13: 全量验证和文档同步

**文件：**
- `docs/task04/checklist.md`
- `README.md`
- `CLAUDE.md`
- 可能涉及 `docs/task04/tasks.md`

**依赖：** T1-T12

**步骤：**
1. 运行 `npm run typecheck`。
2. 运行 `npm test`。
3. 运行 `npm run build`。
4. 运行 `npm run e2e:tmux`。
5. 根据 checklist 阶段文档逐项记录验证证据。
6. 更新 README 当前能力和边界，说明 task04 具备一次工具调用闭环，但不具备多轮 Agent Loop 和权限系统。
7. 更新 CLAUDE.md 当前项目状态、常用验证命令和工具系统边界。
8. 确认 `.agentcode/`、API key、sentinel secret 未进入 git diff。
9. 汇总变更、验证证据、剩余风险和后续建议。

**验证：**
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `npm run e2e:tmux` 通过或明确环境阻塞。
- 文档与实际能力一致，没有声称实现多轮 Agent Loop、权限系统、MCP/plugins/hooks/skills。

**任务后审查：**
验证通过后，启动至少 3 个只读子代理从不同角度审查本任务相关变更：
1. 文档一致性：检查 README/CLAUDE/docs 是否准确描述能力和边界。
2. 质量/回归：检查全量 diff 是否存在遗漏或不必要改动。
3. 安全/发布风险：检查 secret、配置、E2E 和回滚说明是否充分。
若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## 执行顺序

```text
T1
 ↓
T2
 ↓
T3
 ├─────────────┬─────────────┐
 ↓             ↓             ↓
T4            T5            T6
 └─────────────┴─────────────┘
 ↓
T7
 ├─────────────┐
 ↓             ↓
T8            T9
 └──────┬──────┘
        ↓
       T10
        ↓
       T11
        ↓
       T12
        ↓
       T13
```

并行说明：

- T4/T5/T6 在 T3 后可并行实现，但为了降低风险，建议按 T4 → T5 → T6 顺序执行。
- T8/T9 在 T7 后可并行实现，但 Provider 协议差异较大，建议分别验证后再进入 T10。
- T10 是集成关键点，必须等 Tool Runtime 和两个 Provider adapter 均完成后再做。
