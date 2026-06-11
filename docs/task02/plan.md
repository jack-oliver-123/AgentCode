# AgentCode 纯对话 TUI 首版 Plan

## 方案选择摘要

- 候选方案来源：已启动 3 个只读子代理，分别从最小可行/低风险、架构一致性/长期维护、测试与回滚/风险控制角度提出候选方案。
- 最终选择：采用轻量端口-适配器架构，将系统拆为 CLI 启动层、配置层、会话应用层、Provider 适配层、TUI 适配层和测试辅助层。
- 选择理由：该方案能满足已批准 spec 的全部功能需求，同时把 TUI、Provider 协议、配置读取和会话状态隔离开；首版实现纯对话闭环，不引入 tool use 或长期记忆，但为后续 Agent 能力保留清晰扩展边界。
- 丢弃说明：未采用“直接 fetch + stdout 的脚本式 MVP”，因为它会让 TUI、协议和会话历史耦合过深；也不采用过重的完整 Agent runtime 方案，因为 task02 明确不做 tool use、文件操作、权限系统或长期记忆。

## 架构概览

AgentCode 首版由以下模块组成：

1. **CLI 启动层**  
   提供 `agentcode` 命令入口，负责启动应用、捕获顶层错误，并把控制权交给应用装配层。

2. **应用装配层**  
   负责加载配置、创建 Provider、创建会话服务，并启动 TUI。该层只做依赖装配，不承载业务逻辑。

3. **配置层**  
   负责发现 `.agentcode/config.yaml` 和 `~/.agentcode/config.yaml`，解析 YAML，校验字段，归一化配置，并保证错误信息不会泄露完整 API key。

4. **会话应用层**  
   负责当前进程内多轮对话状态：追加用户消息、调用 Provider、聚合流式回复、完成后提交 assistant 消息、失败时保留可恢复状态。

5. **Provider 适配层**  
   负责把统一的对话请求转换成 Anthropic 或 OpenAI 协议请求，发起流式 HTTP 请求，解析 SSE，并输出统一的流式事件。

6. **TUI 适配层**  
   负责终端交互界面，显示对话历史、输入框、状态信息和流式回复。TUI 只消费会话层事件，不直接依赖 Anthropic/OpenAI 协议细节。

7. **测试辅助层**  
   提供 FakeProvider、Mock SSE Server、临时配置目录和输出捕获工具，用于验证流式、多轮上下文、配置优先级和 API key 脱敏。

## 核心数据结构

### RawConfig

YAML 文件中的原始配置。它是用户输入，字段名保持 YAML 风格，加载后必须经过 schema 校验和归一化，不能直接传给 Provider。

```ts
type ProviderProtocol = 'anthropic' | 'openai';

interface RawConfig {
  protocol: ProviderProtocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking?: {
    enabled?: boolean;
    budget_tokens?: number;
  };
  request?: {
    timeout_ms?: number;
    headers?: Record<string, string>;
  };
  ui?: {
    show_thinking?: boolean;
  };
}
```

### AgentConfig

运行时归一化后的配置。它是校验后的运行时真相，字段名使用 TypeScript 风格，供应用层和 Provider 层使用。

```ts
interface AgentConfig {
  protocol: ProviderProtocol;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: {
    enabled: boolean;
    budgetTokens?: number;
  };
  request: {
    timeoutMs: number;
    headers: Record<string, string>;
  };
  ui: {
    showThinking: boolean;
  };
}
```

### ResolvedConfig

配置加载结果，包含来源信息，便于 TUI 和测试观察。

```ts
interface ResolvedConfig {
  source: 'project' | 'global';
  path: string;
  config: AgentConfig;
}
```

### ChatMessage

当前进程内会话历史中的规范消息。

```ts
type MessageRole = 'user' | 'assistant';

type MessagePart =
  | { type: 'text'; text: string };

interface ChatMessage {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
  meta?: {
    model?: string;
    provider?: ProviderProtocol;
    finishReason?: string;
  };
}
```

首版 transcript 默认只保存用户输入和 assistant 最终可见文本。Claude extended thinking 只作为当前 turn 的临时隐藏流处理：Provider 可以产生 `thinking.delta`，会话层可以在 draft 中临时累积，但默认不写入 `messages`，也不带入下一轮上下文。

### ChatSessionState

TUI 可观察的会话状态。

```ts
interface ChatSessionState {
  messages: ChatMessage[];
  draft?: {
    id: string;
    visibleText: string;
    thinkingText: string;
  };
  status: 'idle' | 'streaming' | 'error';
  lastError?: PublicError;
}
```

### ProviderRequest

Provider 统一请求。

```ts
interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  thinking: {
    enabled: boolean;
    budgetTokens?: number;
  };
  signal?: AbortSignal;
}
```

### ProviderEvent

Provider 统一流式事件。

```ts
type ProviderEvent =
  | { type: 'response.start' }
  | { type: 'content.delta'; delta: string }
  | { type: 'thinking.delta'; delta: string }
  | { type: 'response.complete'; finishReason?: string }
  | { type: 'response.error'; error: PublicError };
```

### ChatModelProvider

所有模型后端必须实现的统一接口。

```ts
interface ChatModelProvider {
  protocol: ProviderProtocol;
  supportsExtendedThinking: boolean;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}
```

### PublicError

可展示给用户的错误。

```ts
interface PublicError {
  code:
    | 'config_error'
    | 'auth_error'
    | 'network_error'
    | 'rate_limit'
    | 'provider_error'
    | 'protocol_error'
    | 'unknown_error';
  message: string;
  retryable: boolean;
  status?: number;
}
```

## 模块设计

### CLI 启动层

**职责：** 提供 `agentcode` 命令入口，启动应用，处理未捕获错误。  
**对外接口：** `main(): Promise<void>`。  
**依赖：** 应用装配层。

### 应用装配层

**职责：** 加载配置、创建 Provider、创建会话服务、启动 TUI。  
**对外接口：** `bootstrapApp(options): Promise<void>`。  
**依赖：** 配置层、Provider factory、会话应用层、TUI 适配层。

### 配置层

**职责：**

- 从当前工作目录向上查找最近的 `.agentcode/config.yaml`；
- 找不到项目配置时读取 `~/.agentcode/config.yaml`；
- 解析 YAML；
- 校验 `protocol`、`model`、`base_url`、`api_key`；
- 归一化可选配置；
- 格式化安全错误。

**对外接口：**

```ts
interface ConfigLoader {
  load(): Promise<ResolvedConfig>;
}
```

**依赖：** 文件系统、YAML parser、配置 schema、脱敏工具。

**关键规则：** 如果项目配置存在但非法，直接报错，不回退到全局配置，避免用户误用全局账号或模型。

### 会话应用层

**职责：**

- 保存当前进程内多轮会话；
- 用户提交后追加 user message；
- 调用 Provider 流式接口；
- 将 `content.delta` 追加到当前 assistant draft；
- 将 `thinking.delta` 作为当前 turn 的临时隐藏内容处理；
- 默认不把 thinking 写入 transcript，也不带入下一轮上下文；
- 只有收到 `response.complete` 后才把 assistant 可见文本提交到历史；
- 如果流式失败，丢弃未完成 assistant draft，避免污染下一轮上下文。

**对外接口：**

```ts
interface ChatSessionController {
  getState(): ChatSessionState;
  submitUserText(text: string): AsyncIterable<ChatSessionEvent>;
}
```

**依赖：** Provider 接口、ID 生成器、错误模型。

### Provider 适配层

**职责：**

- 根据协议创建 Anthropic 或 OpenAI provider；
- 将统一消息格式转换为对应协议请求；
- 使用 `baseUrl` 拼接协议 endpoint；
- 通过 SSE 读取流式响应；
- 将厂商事件转换为统一 `ProviderEvent`。

**对外接口：** `ChatModelProvider`。

**依赖：** fetch transport、SSE reader、错误映射、endpoint resolver。

**协议选择：**

- Anthropic：使用 Messages API 的流式能力；支持 extended thinking 请求参数和 thinking 事件解析。
- OpenAI：首版使用 Chat Completions 流式协议，以提升第三方中转站兼容性。

### TUI 适配层

**职责：**

- 渲染对话历史；
- 渲染输入区；
- 渲染状态栏；
- 展示流式 assistant draft；
- 展示可理解错误；
- 默认隐藏 thinking 内容；
- 在 streaming 时避免并发提交。

**对外接口：**

```ts
interface ChatUi {
  start(controller: ChatSessionController, config: ResolvedConfig): void;
}
```

**依赖：** 会话控制器、TUI 框架。

**技术选择：** 使用 Ink + React 实现首版 TUI，因为它能在 TypeScript 生态内较稳定地实现输入区、状态区和流式渲染，避免手写 ANSI 光标控制。

### 测试辅助层

**职责：**

- FakeProvider：不走真实网络，按测试需要输出 provider events；
- Mock SSE Server：返回真实 `text/event-stream` 响应，验证协议和流式行为；
- temp config helper：构造项目配置和全局配置；
- output capture：扫描 stdout/stderr/TUI 输出，确保 API key 不泄露。

## 模块交互

### 启动流程

```text
agentcode
  -> cli/main.ts
  -> bootstrapApp()
  -> loadConfig()
  -> createProvider(resolvedConfig)
  -> create ChatSessionController
  -> start Ink TUI
```

### 单轮对话流程

```text
用户输入问题
  -> TUI 调用 submitUserText(text)
  -> ChatSessionController 追加 user message
  -> ChatSessionController 构造 ProviderRequest
  -> Provider 发起 SSE 请求
  -> Provider 输出 ProviderEvent
  -> ChatSessionController 更新 assistant draft
  -> TUI 增量渲染可见文本
  -> Provider 完成
  -> ChatSessionController 提交 assistant message 到历史
```

### 错误流程

```text
配置错误
  -> 启动前失败
  -> 展示安全错误信息

Provider 错误 / 网络错误 / 协议错误
  -> 当前 turn 失败
  -> 丢弃 assistant draft
  -> 保留历史中的已完成消息
  -> TUI 展示可理解错误
```

## 文件组织

```text
AgentCode/
├── package.json                         — npm scripts、bin 入口和依赖声明
├── tsconfig.json                        — TypeScript 编译配置
├── src/
│   ├── cli/
│   │   └── main.ts                      — `agentcode` 命令入口
│   ├── app/
│   │   └── bootstrapApp.ts              — 应用装配
│   ├── config/
│   │   ├── loadConfig.ts                — 配置发现、读取和加载
│   │   ├── schema.ts                    — YAML 配置校验与归一化
│   │   └── redact.ts                    — API key 脱敏
│   ├── session/
│   │   ├── ChatSessionController.ts     — 多轮会话与流式 turn 管理
│   │   └── types.ts                     — 会话状态与消息类型
│   ├── providers/
│   │   ├── types.ts                     — Provider 统一接口和事件
│   │   ├── createProvider.ts            — Provider factory
│   │   ├── shared/
│   │   │   ├── endpoint.ts              — base_url 与 endpoint 拼接
│   │   │   ├── fetchTransport.ts        — HTTP 请求、超时、状态码处理
│   │   │   ├── sse.ts                   — SSE 流解析
│   │   │   └── errors.ts                — Provider 错误映射
│   │   ├── anthropic/
│   │   │   └── AnthropicProvider.ts     — Anthropic Messages 流式适配
│   │   └── openai/
│   │       └── OpenAIProvider.ts        — OpenAI Chat Completions 流式适配
│   ├── tui/
│   │   ├── App.tsx                      — Ink 根组件
│   │   ├── components/
│   │   │   ├── TranscriptPane.tsx       — 对话历史展示
│   │   │   ├── InputPane.tsx            — 输入区
│   │   │   └── StatusBar.tsx            — 模型、配置来源、状态展示
│   │   └── useChatController.ts         — TUI 与会话控制器桥接
│   └── shared/
│       ├── errors.ts                    — 通用错误类型
│       └── ids.ts                       — ID 生成
├── tests/
│   ├── unit/
│   │   ├── config/
│   │   ├── session/
│   │   └── providers/
│   ├── integration/
│   │   ├── streaming/
│   │   └── cli/
│   ├── e2e/
│   │   └── tmux/
│   └── helpers/
│       ├── FakeProvider.ts
│       ├── createMockSseServer.ts
│       ├── tempConfig.ts
│       └── captureOutput.ts
└── docs/
    └── task02/
        ├── spec.md
        ├── plan.md
        ├── tasks.md
        └── checklist.md
```

## 风险与回滚

- **可能破坏的现有行为：** 当前没有实现代码，不存在功能回归；主要风险是新脚手架和依赖选择不合适。
- **配置风险：** 如果项目配置存在但非法，不应回退全局配置；否则可能误用错误账号或模型。回滚方式是只调整配置发现策略，不影响 Provider/TUI。
- **API key 泄露风险：** 错误处理不得输出完整配置对象、Authorization header 或完整 key。回滚方式是收敛错误出口到 `PublicError` 和 `redactSecret`。
- **SSE 伪流式风险：** 如果实现把完整响应攒完再渲染，会违背 spec。回滚方式是保留 Provider 接口，修正 SSE reader 或 TUI 渲染策略。
- **协议兼容风险：** 第三方中转站可能不完全兼容官方协议。回滚方式是局部修复对应 Provider adapter 或 endpoint resolver，不影响会话和 TUI。
- **thinking 泄露风险：** thinking 默认不得显示，不应混入普通 assistant 文本，不应写入 transcript，也不应带入下一轮上下文。回滚方式是调整 Provider event 到会话 draft/TUI event 的映射，不改协议请求层。
- **上下文污染风险：** 流式失败时如果把半截 assistant 回复写入历史，下一轮会被污染。回滚方式是坚持“收到 complete 后才提交 assistant message”的会话规则。
- **范围膨胀风险：** 不引入 tool use、文件操作、命令执行、长期记忆或权限系统；如果出现相关需求，应拆到后续任务。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 运行时 | Node.js 20+ | 内置 `fetch`、适合 TypeScript CLI，生态成熟。 |
| 包管理 | npm | Node 自带，降低从零初始化门槛。 |
| TUI | Ink + React | 适合 TypeScript 终端 UI，减少手写 ANSI/光标控制风险。 |
| 配置格式 | YAML | 符合 spec 要求，便于人工编辑。 |
| 配置路径 | 项目 `.agentcode/config.yaml` 优先，全局 `~/.agentcode/config.yaml` 兜底 | 模仿 Claude Code 的项目目录约定，并保留全局默认配置。 |
| 配置发现 | 从当前工作目录向上查找最近的 `.agentcode/config.yaml` | 用户在项目子目录运行时也能找到项目配置。 |
| 配置校验 | 运行时 schema 校验 | 及早发现缺字段、非法 protocol、非法 URL，并输出可理解错误。 |
| Provider HTTP | 原生 `fetch` + 自建适配器 | 更容易兼容第三方 `base_url`，避免官方 SDK 绑定官方 endpoint 或私有抽象。 |
| SSE 解析 | 独立 SSE reader | Provider 共享流解析能力，便于测试 chunk 边界和异常流。 |
| OpenAI 协议 | Chat Completions streaming | 第三方中转站兼容度通常更高，足够满足纯对话首版。 |
| Anthropic 协议 | Messages streaming | 与 Claude extended thinking 语义更匹配。 |
| 多轮上下文 | 当前进程内 transcript，发送完整已完成历史 | 满足首版多轮需求，不引入长期记忆或压缩。 |
| assistant 提交规则 | 仅 `response.complete` 后提交到历史 | 避免中断回复污染下一轮上下文。 |
| thinking 处理 | 配置启用请求能力，当前 turn 内临时隐藏处理，TUI 默认隐藏，不写入 transcript，不进入下一轮上下文 | 满足 extended thinking 需求，同时避免将 thinking 当普通回复展示或长期传播。 |
| 并发提交 | 首版 streaming 时禁止再次提交 | 降低状态复杂度，避免多个流同时写 UI。 |
| 测试框架 | Vitest | TypeScript 生态友好，适合单元、集成和 provider 契约测试。 |
| E2E 验收 | tmux + Mock SSE Server | 符合项目约定，能观察真实终端流式行为。 |

## Spec 覆盖映射

| Spec 需求 | Plan 覆盖 |
|-----------|-----------|
| F1 启动入口 | CLI 启动层、`package.json` bin、`src/cli/main.ts` |
| F2 核心 TUI 交互 | TUI 适配层、Ink 组件、输入区/对话区/状态栏 |
| F3 流式回复 | Provider SSE reader、ProviderEvent、assistant draft 增量渲染 |
| F4 多轮上下文 | ChatSessionController、当前进程内 transcript |
| F5 Provider 协议切换 | ProviderFactory、Anthropic/OpenAI adapters |
| F6 第三方中转站兼容 | 可配置 `baseUrl`、endpoint resolver、原生 HTTP adapter |
| F7 统一 Provider 行为 | `ChatModelProvider`、`ProviderEvent` 统一接口 |
| F8 YAML 配置文件 | 配置层、YAML parser、schema 校验 |
| F9 配置文件查找顺序 | 项目 `.agentcode/config.yaml` 优先，全局 `~/.agentcode/config.yaml` 兜底 |
| F10 `.agentcode` 运行目录约定 | 配置发现和文档约定，不在根目录散落 AgentCode 专用配置 |
| F11 Claude extended thinking | Anthropic Provider thinking 支持、TUI 默认隐藏 |
| F12 排除 Agent 工具能力 | 文件组织不创建 tools/executor 模块，Provider capabilities 不开放 tool use |
