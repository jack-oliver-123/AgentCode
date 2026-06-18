# Tool System Plan

## 方案选择摘要

- 候选方案来源：已启动 3 个只读子代理，分别从最小可行/低风险、架构一致性/长期维护、测试与回滚/风险控制角度提出方案。第一次风险控制子代理调用失败后已重新启动，最终获得 3 份有效候选方案。

- 最终选择：采用“独立 Tool Runtime + Provider 工具协议适配 + ChatSessionController 单工具编排”的分层方案。

- 选择理由：
  - Tool Runtime 独立负责工具定义、注册、参数校验、工作区边界、超时、结构化结果和 redaction，避免把本地副作用逻辑散落到 Provider 或 TUI。
  - Provider 只负责把统一工具声明转换为 OpenAI-compatible / Anthropic API 格式，并把流式工具调用碎片转换为统一内部事件，不直接执行工具。
  - ChatSessionController 继续作为会话编排入口，在现有“用户消息 → Provider stream → assistant draft”的基础上扩展为“首轮模型请求 → 最多一次工具执行 → 工具结果回灌 → 最终文本回答”。
  - 第二次请求默认禁用工具声明，从控制流上保证 task04 不进入多轮 Agent Loop。
  - TUI 不理解工具协议，只消费 session state；本阶段最多显示简短工具活动状态，保持 task03 的蓝白小猫纯对话体验不回退。
  - 工具失败默认作为结构化工具结果回灌给模型，而不是直接把会话置为崩溃错误；只有 Provider、协议或会话级不可恢复问题才进入现有 PublicError 路径。
  - 该方案为后续权限系统、Agent Loop、工具审批和 MCP/plugins 扩展保留清晰插入点。

- 丢弃说明：未采用方案不作为后续 tasks.md 依据，不在本文档展开；其中关于最小改动、Provider 差异隔离、路径越界、命令超时、secret redaction、E2E 和回滚的风险点已吸收到最终方案。

## 架构概览

task04 将在现有纯文本会话链路上增加一条受控的工具调用分支。整体仍保持“Provider 负责模型协议、Session 负责回合编排、TUI 负责展示状态”的边界。

### 1. Tool Runtime

Tool Runtime 是新增的本地工具执行层，负责统一工具接口、工具注册、参数校验、工作区路径安全、执行超时、结构化结果和敏感信息清洗。

它不理解 OpenAI 或 Anthropic 的 API wire format，也不直接操作 TUI。它只接收内部统一的工具调用请求，并返回稳定的工具执行结果。

核心职责：

- 定义 `ToolDefinition`、`ToolRegistry`、`ToolExecutionContext`、`ToolExecutionResult`。
- 注册六个内置工具：`read_file`、`write_file`、`edit_file`、`run_command`、`glob_files`、`search_code`。
- 在工具执行前完成参数校验。
- 将所有文件路径限制在当前 workspace 内。
- 为命令和工具执行提供统一超时控制。
- 捕获工具异常，并转换成结构化工具错误。
- 对工具结果、错误、stdout/stderr 和搜索片段做 redaction。

### 2. Provider Tool Adapter

Provider Tool Adapter 是现有 Provider 的扩展能力，负责两件事：

1. 把 AgentCode 内部统一工具声明转换成 Provider API 认识的工具声明。
2. 把 Provider 流式返回的工具调用片段解析成 AgentCode 内部统一事件。

Provider 不执行工具，也不决定是否允许工具调用；它只负责协议适配。

### 3. ChatSessionController Tool Turn

`ChatSessionController` 继续作为会话回合的主编排者。task04 会把当前单段文本流扩展为最多两段 Provider 请求：

1. 首轮请求：带工具声明，让模型可以选择是否调用一个工具。
2. 工具执行：如果首轮出现工具调用，Controller 调用 Tool Runtime 执行一次工具。
3. 最终请求：把工具结果回灌进上下文，再请求模型生成最终文本回答；这一段不再暴露工具声明，避免进入自动 Agent Loop。

没有工具调用时，Controller 沿用当前纯文本路径，保持现有流式显示和上下文追加行为。

### 4. Session State / TUI

TUI 不直接理解工具协议，不展示原始工具 JSON，也不负责工具执行。它仍通过 `ChatSessionState` 观察会话。

`ChatSessionDraft` 增加轻量活动状态，用于显示：

- `Thinking`
- `Using read_file`
- `Using run_command`
- `Writing · N chars`

### 5. Error and Redaction Boundary

错误分两层处理：

- Provider、网络、配置、协议级不可恢复错误继续使用现有 `PublicError`，显示在 `NoticeBar`。
- 工具自身失败默认返回 `ToolExecutionResult.ok=false`，作为工具结果回灌给模型，让模型向用户解释失败或提出下一步建议。

所有进入模型上下文、TUI、stdout/stderr、测试快照的工具输出，都必须经过统一 redaction。

## 核心数据结构

### ToolDefinition

```ts
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  risk: ToolRisk;
  validate(input: unknown): ToolValidationResult<TInput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolExecutionResult<TOutput>>;
}
```

### ToolRisk

```ts
export type ToolRisk = 'read' | 'write' | 'execute';
```

### ToolRegistry

```ts
export interface ToolRegistry {
  list(): readonly ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  getProviderDeclarations(): ProviderToolDeclaration[];
}
```

### ProviderToolDeclaration

```ts
export interface ProviderToolDeclaration {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
}
```

### ProviderRequest

```ts
export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  thinking: {
    enabled: boolean;
    budgetTokens?: number;
  };
  tools?: ProviderToolDeclaration[];
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}
```

### ProviderEvent

```ts
export type ProviderEvent =
  | { type: 'response.start' }
  | { type: 'content.delta'; delta: string }
  | { type: 'thinking.delta'; delta: string }
  | { type: 'tool.call'; call: ProviderToolCall }
  | { type: 'response.complete'; finishReason?: string }
  | { type: 'response.error'; error: PublicError };
```

### ProviderToolCall

```ts
export interface ProviderToolCall {
  id: string;
  name: string;
  argumentsText: string;
}
```

### ToolExecutionContext

```ts
export interface ToolExecutionContext {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  secrets: readonly string[];
  maxOutputBytes: number;
}
```

### ToolExecutionResult

```ts
export type ToolExecutionResult<TData = unknown> =
  | {
      ok: true;
      toolName: string;
      data: TData;
      meta: ToolExecutionMeta;
    }
  | {
      ok: false;
      toolName: string;
      error: ToolExecutionError;
      meta: ToolExecutionMeta;
    };
```

### ToolExecutionMeta

```ts
export interface ToolExecutionMeta {
  durationMs: number;
  timedOut: boolean;
  truncated?: boolean;
}
```

### ToolExecutionError

```ts
export interface ToolExecutionError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

### ToolErrorCode

```ts
export type ToolErrorCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'path_outside_workspace'
  | 'file_not_found'
  | 'file_not_text'
  | 'not_unique_match'
  | 'permission_denied'
  | 'command_failed'
  | 'command_timeout'
  | 'output_too_large'
  | 'tool_internal_error';
```

### ChatSessionDraft 扩展

```ts
export interface ChatSessionDraft {
  id: string;
  visibleText: string;
  thinkingText: string;
  activity?: ChatSessionActivity;
}
```

```ts
export type ChatSessionActivity =
  | { type: 'model'; label?: string }
  | { type: 'tool'; toolName: string };
```

## 模块设计

### Tool Types

**职责：** 定义工具系统的公共类型，包括工具定义、工具注册中心、工具执行上下文、工具结果、工具错误和 Provider 工具声明。

**对外接口：**

- `ToolDefinition`
- `ToolRegistry`
- `ToolExecutionContext`
- `ToolExecutionResult`
- `ToolExecutionError`
- `ProviderToolDeclaration`

**依赖：** 仅依赖 TypeScript 类型和现有 `PublicError` 类型；不依赖具体工具实现、Provider 或 TUI。

### Tool Registry

**职责：** 集中登记 task04 的六个内置工具，并提供按名称查找和导出 Provider 工具声明的能力。

**对外接口：**

- `createDefaultToolRegistry(options)`
- `registry.list()`
- `registry.get(name)`
- `registry.getProviderDeclarations()`

### Tool Executor

**职责：** 统一执行模型请求的工具调用，负责 JSON 参数解析、未知工具处理、参数校验、超时包装、异常捕获、结果 redaction 和结构化错误返回。

**对外接口：**

```ts
executeToolCall(call, registry, context): Promise<ToolExecutionResult>
```

### Workspace Safety

**职责：** 为所有文件类工具提供统一路径解析和工作区边界检查。

**对外接口：**

```ts
resolveWorkspacePath(cwd, inputPath): Promise<WorkspacePathResult>
```

### Tool Redaction

**职责：** 对工具结果中的字符串、stdout/stderr、文件内容片段、搜索片段和错误消息做统一敏感信息清洗。

**对外接口：**

```ts
redactToolResult(result, secrets): ToolExecutionResult
redactToolValue(value, secrets): unknown
```

### Built-in Tools

#### read_file

输入：

```ts
{ path: string; maxBytes?: number }
```

输出：

```ts
{ path: string; content: string; bytes: number; truncated: boolean }
```

#### write_file

输入：

```ts
{ path: string; content: string; overwrite?: boolean }
```

输出：

```ts
{ path: string; bytesWritten: number }
```

默认不覆盖已有文件；覆盖必须显式传 `overwrite: true`。

#### edit_file

输入：

```ts
{ path: string; oldText: string; newText: string }
```

输出：

```ts
{ path: string; replacements: 1 }
```

仅当 `oldText` 唯一出现时写回。

#### run_command

输入：

```ts
{ command: string; timeoutMs?: number }
```

输出：

```ts
{
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}
```

非零退出码作为可观察结果返回；超时或无法启动命令才作为工具错误。

#### glob_files

输入：

```ts
{ pattern: string; maxResults?: number }
```

输出：

```ts
{ matches: string[]; truncated: boolean }
```

先实现受控 glob 子集：`*`、`**`、`?`，并默认跳过 `.git`、`node_modules`、`dist`。

#### search_code

输入：

```ts
{ query: string; regex?: boolean; include?: string; maxResults?: number }
```

输出：

```ts
{
  matches: Array<{
    path: string;
    line: number;
    preview: string;
  }>;
  truncated: boolean;
}
```

### Provider Types

**职责：** 扩展当前 Provider 内部协议，支持工具声明和工具调用事件，同时保持纯文本事件兼容。

### OpenAI Provider Tool Adapter

**职责：** 在 OpenAI-compatible Chat Completions 请求中附带工具声明，并解析流式工具调用。

### Anthropic Provider Tool Adapter

**职责：** 在 Anthropic Messages 请求中附带工具声明，并解析流式 `tool_use` block。

### ChatSessionController Tool Turn

**职责：** 编排一次用户请求中的工具闭环。

流程：

1. 用户提交文本后，创建 user message 和 draft。
2. 首轮 Provider 请求带工具声明。
3. 如果只收到文本，沿用现有完成逻辑。
4. 如果收到一个 `tool.call`：
   - 更新 draft activity 为 `tool`。
   - 执行工具一次。
   - 将工具结果作为上下文消息回灌。
   - 发起第二次 Provider 请求生成最终文本。
5. 第二次请求不再暴露工具声明。
6. 如果第二次仍出现工具调用，不执行，返回清晰错误或最终说明。
7. 最终只把模型最终文本提交为 assistant message。

### Bootstrap Integration

**职责：** 在应用启动时创建默认工具注册中心，并把 workspace cwd、config secret 和工具设置注入 `ChatSessionController`。

### TUI Activity Display

**职责：** 延续 task03 的简短运行状态设计，展示工具活动，但不展示原始工具 JSON。

## 模块交互

### 普通纯文本对话路径

1. 用户在 TUI 输入问题。
2. `InputPane` 调用 `submitText`。
3. `useChatController` 调用 `ChatSessionController.submitUserText()`。
4. `ChatSessionController` 创建 user message 和 assistant draft。
5. `ChatSessionController` 构造 `ProviderRequest`。
6. Provider 流式返回 `content.delta`。
7. `ChatSessionController` 将文本追加到 draft。
8. 收到 `response.complete` 后提交 assistant message。
9. TUI 显示最终文本，状态回到 `ready`。

### 一次工具调用路径

1. 用户提交问题。
2. `ChatSessionController` 发起首轮 Provider 请求，携带工具声明。
3. Provider 从模型流中解析出工具调用。
4. Provider 产出统一 `tool.call` 事件。
5. `ChatSessionController` 收到第一个 `tool.call`：
   - 停止把首轮输出作为最终 assistant 消息提交。
   - 更新 draft activity。
   - 调用 `executeToolCall(call, registry, context)`。
6. `executeToolCall` 完成 JSON parse、工具查找、参数校验、超时、执行、异常捕获和 redaction。
7. `ChatSessionController` 将工具结果序列化为模型上下文消息。
8. `ChatSessionController` 发起第二轮 Provider 请求，不再传工具声明。
9. Provider 流式返回最终文本回答。
10. `ChatSessionController` 提交最终 assistant message。
11. TUI 展示最终回答，状态回到 `ready`。

### 工具失败路径

工具失败不是默认会话失败，而是模型可观察结果：

1. 工具参数无效、未知工具、路径越界、文件不存在、命令超时或执行异常。
2. `executeToolCall` 返回 `ok: false` 的结构化结果。
3. `ChatSessionController` 把该结构化失败结果回灌给模型。
4. 模型生成最终文本，向用户解释失败原因或建议下一步。
5. 会话不崩溃；除非 Provider 第二轮请求本身失败，才进入 `lastError`。

### 第二次工具调用限制路径

1. 首轮已经执行过一个工具。
2. Controller 发起第二轮 Provider 请求时禁用工具声明。
3. 如果 Provider 仍返回 `tool.call`：
   - Controller 不执行该工具。
   - 记录为单工具边界违规。
   - 结束本轮并返回安全说明，或转换成 `protocol_error`。
4. 工具执行计数必须保持为 1。

### Provider 工具声明数据流

1. `createDefaultToolRegistry()` 创建六个工具。
2. `registry.getProviderDeclarations()` 输出内部统一声明。
3. OpenAI Provider 映射为 Chat Completions tools schema。
4. Anthropic Provider 映射为 Messages tools schema。
5. Provider API 细节不泄漏到工具实现和 Controller。

### Redaction 数据流

1. `bootstrapApp` 将 `config.apiKey` 和其他已知 secret 放入工具上下文。
2. 工具执行产生原始结果。
3. `executeToolCall` 在结果返回 Controller 前执行 redaction。
4. Controller 只接收 redacted 工具结果。
5. redacted 工具结果进入 Provider 第二轮上下文、session state、TUI 和测试输出。
6. 未 redacted 的工具原始输出不得进入 session state。

## 文件组织

```text
src/tools/
  types.ts
  schemas.ts
  registry.ts
  executor.ts
  workspace.ts
  redaction.ts
  builtins/
    read-file.ts
    write-file.ts
    edit-file.ts
    run-command.ts
    glob-files.ts
    search-code.ts
    index.ts
```

### 新增文件职责

- `src/tools/types.ts` — 工具系统公共类型。
- `src/tools/schemas.ts` — JSON Schema helper 和六个工具输入 schema。
- `src/tools/registry.ts` — 默认工具注册中心。
- `src/tools/executor.ts` — 统一工具执行入口。
- `src/tools/workspace.ts` — workspace 路径解析和越界检查。
- `src/tools/redaction.ts` — 工具结果递归 redaction。
- `src/tools/builtins/read-file.ts` — `read_file` 工具。
- `src/tools/builtins/write-file.ts` — `write_file` 工具。
- `src/tools/builtins/edit-file.ts` — `edit_file` 工具。
- `src/tools/builtins/run-command.ts` — `run_command` 工具。
- `src/tools/builtins/glob-files.ts` — `glob_files` 工具。
- `src/tools/builtins/search-code.ts` — `search_code` 工具。
- `src/tools/builtins/index.ts` — 内置工具统一导出。

### 修改文件

```text
src/providers/types.ts
src/providers/openai/OpenAIProvider.ts
src/providers/anthropic/AnthropicProvider.ts
src/session/types.ts
src/session/ChatSessionController.ts
src/app/bootstrapApp.tsx
src/tui/components/TranscriptPane.tsx
tests/unit/tools/*.test.ts
tests/integration/streaming/openai.test.ts
tests/integration/streaming/anthropic.test.ts
tests/integration/cli/cli.test.tsx
tests/e2e/tmux/agentcode-smoke.sh
```

## 风险与回滚

### 可能破坏的现有行为

- **纯文本对话回归**
  - 风险：Provider request 增加工具声明后，普通聊天可能不再按原来的 `content.delta → response.complete` 流程返回。
  - 控制：`ProviderRequest.tools` 必须是可选字段；没有工具注册中心或禁用工具时，不发送工具声明。
  - 验证：保留并扩展现有 CLI/TUI 和 Provider streaming 测试，确保无工具调用场景仍通过。

- **ChatSessionController 复杂度上升**
  - 风险：在当前 `submitUserText()` 中直接塞入两段 Provider 请求、工具执行和错误处理，可能导致状态机难维护。
  - 控制：把“工具闭环”拆成私有方法或小型 helper，保持主流程可读。
  - 验证：用 session 集成测试覆盖普通文本、工具成功、工具失败、第二次工具调用被拒绝四类路径。

- **TUI 输出泄漏内部细节**
  - 风险：工具结果 JSON、stdout/stderr 或内部错误堆栈被直接显示在 transcript。
  - 控制：TUI 只显示简短 activity，例如 `Using read_file`；最终解释交给模型文本回答。
  - 验证：TUI render 测试和 tmux/psmux pane capture 不包含原始 secret、内部 stack 或未 redacted 工具结果。

### 安全/权限/隐私影响

- **文件越界访问**
  - 风险：模型通过 `../`、绝对路径、Windows 盘符、symlink/junction 访问 workspace 外文件。
  - 控制：所有文件类工具统一调用 workspace safety 模块；路径 resolve/realpath 后必须位于 workspace 内。
  - 验证：单测覆盖相对路径越界、绝对路径越界、symlink 指向外部、父目录越界。

- **写文件/改文件误操作**
  - 风险：模型静默覆盖用户文件，或 edit_file 匹配多处后误改。
  - 控制：`write_file` 默认不覆盖已有文件，覆盖必须显式传 `overwrite: true`；`edit_file` 只允许原文唯一匹配。
  - 验证：写入已有文件默认失败；edit 匹配 0 次或多次时文件内容保持不变。

- **命令执行风险**
  - 风险：`run_command` 可执行本地命令，但 task04 暂不实现权限审批或 sandbox。
  - 控制：命令固定在 workspace cwd 下执行；只支持一次性非交互命令；必须有超时和输出大小限制；stdout/stderr 必须 redaction。
  - 验证：命令成功、非零退出码、超时、大输出、secret 输出分别有测试。

- **敏感信息泄漏**
  - 风险：工具读取配置文件、命令输出环境变量、搜索匹配 API key 后进入模型上下文、TUI 或测试快照。
  - 控制：工具原始结果返回 Controller 前统一 redaction；`config.apiKey` 和常见 secret pattern 都纳入清洗。
  - 验证：API key、Authorization header、Bearer token、JWT、sentinel secret 不出现在工具结果、最终消息、TUI output、stdout/stderr、E2E pane log。

### Provider 协议风险

- **OpenAI-compatible 和 Anthropic 工具流差异**
  - 风险：两个协议的工具声明和流式参数碎片格式不同，解析错误会导致工具参数错乱。
  - 控制：协议差异限制在 Provider adapter 内部；Controller 只消费统一 `tool.call`。
  - 验证：分别为 OpenAI-compatible `delta.tool_calls` 和 Anthropic `input_json_delta` 添加分片 JSON 测试。

- **JSON 参数碎片不完整或非法**
  - 风险：模型或 Provider 返回的工具参数不是合法 JSON，或 JSON 被拆成多个片段。
  - 控制：Provider 内部只拼接字符串；完整后再交给 Tool Executor 解析；解析失败返回结构化错误或协议错误。
  - 验证：覆盖合法分片、转义字符跨片段、空参数、非法 JSON。

- **第二轮再次工具调用**
  - 风险：工具结果回灌后模型继续请求工具，导致无意进入 Agent Loop。
  - 控制：第二轮请求不暴露工具声明或设置 `toolChoice: "none"`；即使收到工具调用也不执行。
  - 验证：FakeProvider 返回第二个 `tool.call` 时，工具执行计数仍为 1。

### 数据兼容性或迁移影响

- task04 不引入数据库、持久化会话格式或配置迁移。
- `ChatMessage` / Provider message 类型可能扩展工具上下文表达，但只影响运行时内存结构。
- 如需要新增配置项，例如 `tools.enabled` 或工具 timeout，应保持默认行为不破坏现有 config 文件。

### 回滚方案

- `ChatSessionController` 的工具注册中心为可选项。
- 未注入 registry 时，Controller 完全走 task04 前的纯文本路径。
- `ProviderRequest.tools` 为可选字段；不传时 Provider 请求体不包含工具声明。
- 如果实现中加入 `tools.enabled` 或环境变量开关，禁用后不注册工具、不发送工具声明、不执行工具调用。
- 局部回滚优先级：
  1. 停止在 bootstrap 中注入默认工具注册中心，恢复纯文本对话。
  2. 保留工具代码但不向 Provider 发送工具声明。
  3. 回滚 Provider 工具 adapter，保留 Tool Runtime 单测代码。
  4. 最后才整体 revert task04。
- task04 不自动 git commit、不自动 push、不自动创建 PR。
- `write_file` / `edit_file` 结果返回路径和写入摘要，便于用户用 git diff 检查。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 工具执行位置 | 在独立 Tool Runtime 中执行，不在 Provider 中执行 | Provider 只负责模型协议适配；本地副作用、路径安全、超时和 redaction 必须集中管理，避免协议层和执行层耦合。 |
| 回合编排位置 | 由 `ChatSessionController` 编排一次工具闭环 | 当前 Controller 已经管理消息历史、draft、streaming/error 状态，是扩展“首轮模型请求 → 工具执行 → 最终回答”的自然位置。 |
| 工具调用上限 | 每个用户请求最多执行 1 个工具 | 严格符合 task04 spec，把多轮 Agent Loop、多工具链式调用和权限审批留到后续任务。 |
| 第二轮 Provider 请求 | 不暴露工具声明，或设置 `toolChoice: "none"` | 从控制流上防止模型拿到工具结果后继续请求工具，避免隐式进入 Agent Loop。 |
| Provider 工具事件 | Provider 内部拼接参数碎片，对 Controller 只暴露完整 `tool.call` | OpenAI-compatible 和 Anthropic 的流式工具参数格式差异较大，Controller 不应理解这些 wire format。 |
| 工具结果失败处理 | 工具失败作为结构化工具结果回灌模型，不默认变成 `lastError` | 文件不存在、参数错误、命令超时等是模型可以解释和调整的观察结果，不应让整个会话崩溃。 |
| 文件路径安全 | 所有文件类工具统一使用 workspace safety 模块 | 避免每个工具重复实现路径检查，降低 `../`、绝对路径、symlink/junction 越界遗漏风险。 |
| 写文件覆盖策略 | `write_file` 默认不覆盖已有文件，覆盖必须显式声明 | 写入工具有真实副作用，默认保守更符合无权限系统阶段的安全边界。 |
| 编辑文件策略 | 仅允许原文唯一匹配替换 | 与 spec 一致；匹配不到或匹配多次都不修改文件，并给模型明确可重试错误。 |
| 命令执行结果 | 非零退出码作为成功工具观察结果返回，超时/启动失败才作为工具错误 | 命令运行完成但 exit code 非 0 是模型需要看到的事实；这不同于工具系统本身执行失败。 |
| Glob 实现 | task04 先实现受控内部 glob 子集，不新增依赖 | 当前 `package.json` 没有 glob 依赖；先支持 `*`、`**`、`?` 和默认排除目录，降低依赖变更。后续如需求增长再引入成熟库。 |
| Search 实现 | 用 Node 内部文件遍历 + 文本/正则匹配，不 shell 调用 `grep`/`rg` | 保持跨平台，避免 shell 注入和外部命令依赖；性能优化留到后续。 |
| Redaction 时机 | 工具结果进入 Controller / Provider 第二轮上下文前完成 redaction | TUI、测试快照和模型上下文都只接触 redacted 结果，避免只在 UI 层补救。 |
| TUI 展示 | 只展示简短工具 activity，不展示原始工具 JSON | 延续 task03 简洁 transcript 设计，避免 stdout/stderr、内部错误和工具结构污染 UI。 |
| 回滚方式 | 工具 registry 可选注入；不注入时恢复纯文本路径 | 工具系统出现问题时可以先关闭入口，而不是整体回滚所有代码。 |
