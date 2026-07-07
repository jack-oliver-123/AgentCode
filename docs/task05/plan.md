# Agent Loop Plan

## 方案选择摘要

- 候选方案来源：3 个子代理分别从最小可行、架构一致性、测试与回滚角度提出。
- 最终选择：架构一致性方案（Agent Loop 为独立纯函数 async generator 模块）
- 选择理由：Controller 原地改造会膨胀为屎山；独立模块职责清晰、可测试、可扩展。吸收测试方案中 StopCondition 纯函数化和 Promise.allSettled 策略。
- 丢弃说明：最小改动方案因 Controller 膨胀问题不采用；测试方案的分阶段回滚开关不采用（直接替换），其余有价值的测试策略已融入最终方案。

## 架构概览

Agent Loop 作为独立模块（`src/agent/`），是一个纯函数式 async generator。`ChatSessionController` 从"执行者"退化为"适配器"——接收用户输入、委托 AgentLoop 执行、将 AgentLoopEvent 翻译为 ChatSessionEvent（对外接口 `state.changed` 不变，TUI 改动最小）。

```
┌─────────────────────────────────────────────────────────┐
│  TUI Layer (Ink)                                         │
│  useChatController → TranscriptPane                      │
│       ▲ 订阅 ChatSessionEvent { type: 'state.changed' } │
└───────┼─────────────────────────────────────────────────┘
        │
┌───────┼─────────────────────────────────────────────────┐
│  Session Layer                                           │
│  ChatSessionController (瘦壳：状态投影 + 事件转换)        │
│  applyAgentLoopEvent() → 更新 draft → yield state.changed│
│       ▲ for await (event of runAgentLoop(...))           │
└───────┼─────────────────────────────────────────────────┘
        │ AsyncGenerator<AgentLoopEvent>
┌───────┼─────────────────────────────────────────────────┐
│  Agent Layer (新模块，纯逻辑，无 UI 依赖)                 │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐   │
│  │ runAgentLoop │ │ToolScheduler │ │ stopCondition  │   │
│  │ (主循环)     │─│(并发调度)     │ │ (纯函数判断)   │   │
│  └──────────────┘ └──────────────┘ └────────────────┘   │
│       │                                                  │
│       ▼                                                  │
│  Provider.stream() + ToolRegistry + executeToolCall()    │
└─────────────────────────────────────────────────────────┘
```

各组件职责：
- **runAgentLoop** — 主循环 async generator，协调 LLM 调用、工具执行、停止判断，yield 事件流
- **ToolScheduler** — 接收一组工具调用，按 risk 分批，read 并发 / write+execute 串行
- **stopCondition** — 纯函数，输入当前循环状态，输出是否停止及原因
- **ChatSessionController** — 薄壳，将 AgentLoopEvent 映射为 draft 状态更新，对外仍 yield state.changed

## 核心数据结构

### AgentLoopConfig

```typescript
/** Agent Loop 配置 */
interface AgentLoopConfig {
  /** 最大迭代次数，默认 50 */
  maxIterations: number;
  /** 连续调用不存在工具的容忍次数，默认 3 */
  maxConsecutiveUnknownTools: number;
}
```

### AgentLoopInput

```typescript
/** Agent Loop 输入 */
interface AgentLoopInput {
  /** 历史上下文消息（前序 turn） */
  contextMessages: ProviderMessage[];
  /** 当前用户消息 */
  userMessage: ProviderMessage;
  /** 运行模式 */
  mode: 'full' | 'plan';
  /** /do 时注入的已存储计划 */
  plan?: PlanStep[];
  /** 取消信号 */
  signal?: AbortSignal;
}
```

### AgentLoopDeps

```typescript
/** Agent Loop 依赖（注入） */
interface AgentLoopDeps {
  provider: ChatModelProvider;
  toolRegistry: ToolRegistry;
  /** 工厂函数，每次工具执行时创建新的 context（确保 signal 正确传播） */
  createToolContext: (signal?: AbortSignal) => ToolExecutionContext;
  config: AgentLoopConfig;
}
```

### PlanStep

```typescript
/** 结构化计划步骤 */
interface PlanStep {
  title: string;
  description: string;
}
```

### AgentLoopEvent（完整 payload）

```typescript
/** Agent Loop 对外事件流（discriminated union） */
type AgentLoopEvent =
  | AgentLoopIterationStart
  | AgentLoopTextDelta
  | AgentLoopThinkingDelta
  | AgentLoopToolCallStart
  | AgentLoopToolCallResult
  | AgentLoopPlanSubmitted
  | AgentLoopTokenUsage
  | AgentLoopCompleted
  | AgentLoopFailed;

interface AgentLoopIterationStart {
  type: 'iteration.start';
  /** 当前第几轮（从 1 开始） */
  iteration: number;
  /** 配置的最大迭代数 */
  maxIterations: number;
}

interface AgentLoopTextDelta {
  type: 'text.delta';
  /** 本次增量文本 */
  delta: string;
}

interface AgentLoopThinkingDelta {
  type: 'thinking.delta';
  /** 本次增量 thinking 文本 */
  delta: string;
}

interface AgentLoopToolCallStart {
  type: 'tool_call.start';
  /** 工具调用信息 */
  call: ProviderToolCall;
  /** 该工具是否在当前 registry 中注册 */
  knownTool: boolean;
  /** 所属迭代轮次 */
  iteration: number;
}

interface AgentLoopToolCallResult {
  type: 'tool_call.result';
  /** 工具调用信息 */
  call: ProviderToolCall;
  /** 执行结果 */
  result: ToolExecutionResult;
  /** 执行耗时 ms */
  durationMs: number;
  /** 所属迭代轮次 */
  iteration: number;
}

interface AgentLoopPlanSubmitted {
  type: 'plan.submitted';
  /** 结构化计划步骤列表 */
  steps: PlanStep[];
}

interface AgentLoopTokenUsage {
  type: 'token.usage';
  /** 本轮 prompt tokens（增量） */
  promptTokens?: number;
  /** 本轮 completion tokens（增量） */
  completionTokens?: number;
  /** 累计 prompt tokens */
  totalPromptTokens: number;
  /** 累计 completion tokens */
  totalCompletionTokens: number;
}

interface AgentLoopCompleted {
  type: 'loop.completed';
  /** 最终文本回答（最后一轮累积） */
  finalText: string;
  /** 总迭代次数 */
  totalIterations: number;
  /** 终止原因 */
  reason: AgentLoopStopReason;
}

interface AgentLoopFailed {
  type: 'loop.failed';
  /** 错误信息 */
  error: PublicError;
  /** 出错时的迭代轮次 */
  iteration: number;
}

type AgentLoopStopReason =
  | 'natural'              // 模型返回纯文本
  | 'max_iterations'       // 达到迭代上限
  | 'cancelled'            // 用户取消
  | 'unknown_tool_limit';  // 连续幻觉工具
```

### StopConditionContext

```typescript
/** 停止条件判断的输入（纯函数） */
interface StopConditionContext {
  iteration: number;
  maxIterations: number;
  consecutiveUnknownTools: number;
  maxConsecutiveUnknownTools: number;
  signal?: AbortSignal;
  /** 本轮是否有工具调用 */
  hasToolCalls: boolean;
  /** 本轮是否有 provider 错误 */
  hasError: boolean;
}

type StopDecision =
  | { stop: false }
  | { stop: true; reason: AgentLoopStopReason | 'provider_error' };
```

### ToolBatch

```typescript
/** 工具调度批次 */
interface ToolBatch {
  calls: ProviderToolCall[];
  mode: 'concurrent' | 'sequential';
}
```

## 模块设计

### runAgentLoop（主循环）

**职责：** 协调 ReAct 循环——调用 LLM、判断停止条件、分发工具执行、组装上下文、yield 事件流。

**对外接口：**
```typescript
function runAgentLoop(
  input: AgentLoopInput,
  deps: AgentLoopDeps
): AsyncGenerator<AgentLoopEvent, void, undefined>
```

**依赖：** ChatModelProvider、ToolRegistry、ToolScheduler、stopCondition、executeToolCall

**内部流程：**
1. 根据 mode 调用 registry.filterByRisk() 过滤工具集（plan 模式只保留 read 类 + submit_plan）
2. 构建初始消息数组（contextMessages + userMessage，plan 时注入已有计划为 system context）
3. 进入 while 循环：
   - yield `iteration.start`
   - 检查 signal.aborted → 提前退出
   - 调用 provider.stream()，流式收集（双路：yield text.delta/thinking.delta + 累积完整响应）
   - 流结束后检查：未收到 response.complete 视为 protocol error
   - 判断：无工具调用 → yield `loop.completed` reason: natural
   - 有工具调用 → 交给 ToolScheduler
   - 更新 consecutiveUnknownTools 计数（遇到已注册工具则重置为 0）
   - 调用 stopCondition 检查是否应该终止
   - 将 assistant 消息 + tool results 追加到消息数组
   - 继续下一轮

**Generator cleanup 策略：**
- `finally` 块中：如果循环未正常结束（消费者意外退出、throw 进 generator），不做额外清理——工具执行已经共享外部传入的 signal，消费者可通过 abort signal 取消所有 pending 操作
- runAgentLoop 本身不持有任何需要释放的资源（无 file handle、无 timer、无 EventEmitter listener）
- 如果正在执行 provider.stream()，for-await-of 的 break/return 会自动调用 provider stream 的 return()

### ToolScheduler（并发调度）

**职责：** 接收一组工具调用，按 risk 分批，执行并返回全部结果。

**对外接口：**
```typescript
function createBatches(calls: ProviderToolCall[], registry: ToolRegistry): ToolBatch[];

function executeBatches(
  batches: ToolBatch[],
  registry: ToolRegistry,
  context: ToolExecutionContext
): Promise<Array<{ call: ProviderToolCall; result: ToolExecutionResult; durationMs: number }>>;
```

**依赖：** ToolRegistry（查询 risk）、executeToolCall（已有）

**调度规则：**
- 所有 risk=read 的工具归入一个 concurrent batch
- 每个 risk=write 或 risk=execute 的工具各占一个 sequential batch
- 未知工具（registry 中不存在）：不进入任何 batch，直接产出 unknown_tool error 结果，不实际调用 executeToolCall
- batch 执行顺序：concurrent batch 先执行，sequential batch 按原始调用顺序串行
- concurrent batch 使用 Promise.allSettled（单个超时/失败不影响其余）
- 结果按原始调用顺序排列（与 Provider 返回的 tool call 顺序一致）

**abort 传播：**
- 所有 batch 共享同一个 signal
- abort 发生时，当前 batch 内正在执行的工具通过 signal 感知取消，后续 batch 不再开始执行

### stopCondition（停止判断）

**职责：** 纯函数，输入循环当前状态，输出是否停止以及原因。

**对外接口：**
```typescript
function checkStopCondition(ctx: StopConditionContext): StopDecision;
```

**依赖：** 无（纯函数）

**判断优先级：**
1. signal.aborted → cancelled
2. hasError → provider_error
3. !hasToolCalls（模型返回纯文本）→ natural
4. consecutiveUnknownTools >= max → unknown_tool_limit
5. iteration >= maxIterations → max_iterations
6. 以上都不满足 → { stop: false }

**边界行为：**
- consecutiveUnknownTools 计数在遇到至少一个已注册工具的调用时重置为 0
- 空文本 + 无工具调用 = natural 完成（不是 error）
- cancelled 优先级最高，即使同时满足其他条件也返回 cancelled

### submit_plan 工具

**职责：** Plan Mode 下模型通过此工具输出结构化计划。

**risk:** `read`（不产生副作用）

**inputSchema:**
```json
{
  "type": "object",
  "properties": {
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" }
        },
        "required": ["title", "description"]
      }
    }
  },
  "required": ["steps"]
}
```

**execute:** 直接返回 steps 数据。AgentLoop 识别 submit_plan 调用后 yield `plan.submitted` 事件，然后结束循环（reason: natural）。

### ChatSessionController（重构为适配器）

**职责：** 管理会话状态（messages、draft、status），委托 AgentLoop 执行，将 AgentLoopEvent 映射为 draft 更新。

**对外接口不变：** `submitUserText()` 返回 `AsyncIterable<ChatSessionEvent>`，事件仍为 `{ type: 'state.changed', state }`。TUI 无需感知内部变化。

**改造要点：**
- `submitUserText()` 内部不再有 provider 调用和工具执行逻辑
- 创建 AgentLoopInput/Deps，for await 遍历 runAgentLoop()
- `applyAgentLoopEvent()` 方法将每个事件翻译为 draft 状态变更并 yield state.changed
- 新增 `currentMode`（'full' | 'plan'）和 `storedPlan: PlanStep[]` 字段
- 识别 `/plan` 和 `/do` 前缀命令切换模式

### ToolRegistry 扩展

**新增接口：**
```typescript
interface ToolRegistry {
  // 现有
  list(): readonly ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  getProviderDeclarations(): ProviderToolDeclaration[];
  // 新增
  filterByRisk(allowedRisks: ToolRisk[]): ToolRegistry;
}
```

`filterByRisk` 返回一个新的 ToolRegistry 实例，只包含指定 risk 级别的工具。Plan Mode 调用 `registry.filterByRisk(['read'])` 获得只读 registry。

## 模块交互

### 完整数据流（多步任务）

```
用户输入 "读取 A 文件内容，写入 B 文件"
         │
         ▼
ChatSessionController.submitUserText(text, { signal })
  │ 1. 创建 userMessage，push 到 messages[]
  │ 2. status = 'streaming'，创建 draft
  │ 3. yield state.changed
  │ 4. 构建 AgentLoopInput + AgentLoopDeps
  │
  │ for await (event of runAgentLoop(input, deps)):
  │     │
  │     ▼
  │ runAgentLoop()
  │  │
  │  │ ── iteration 1 ──
  │  │  yield iteration.start(1, 50)
  │  │  provider.stream(messages + toolDeclarations)
  │  │    → content.delta "让我先读取文件" → yield text.delta
  │  │    → tool.call { read_file, path: "A" }
  │  │    → response.complete
  │  │  stopCondition({ hasToolCalls: true, ... }) → { stop: false }
  │  │  yield tool_call.start { read_file, knownTool: true }
  │  │  ToolScheduler.executeBatches([ { calls: [read_file], mode: 'concurrent' } ])
  │  │    → executeToolCall(read_file) → 结果: 文件内容
  │  │  yield tool_call.result { read_file, result, durationMs }
  │  │  追加 assistant msg + tool result msg 到 messages
  │  │
  │  │ ── iteration 2 ──
  │  │  yield iteration.start(2, 50)
  │  │  provider.stream(messages 含第一轮工具结果)
  │  │    → tool.call { write_file, path: "B", content: "..." }
  │  │    → response.complete
  │  │  stopCondition → { stop: false }
  │  │  yield tool_call.start { write_file }
  │  │  ToolScheduler.executeBatches([ { calls: [write_file], mode: 'sequential' } ])
  │  │  yield tool_call.result { write_file, result, durationMs }
  │  │  追加消息到 messages
  │  │
  │  │ ── iteration 3 ──
  │  │  yield iteration.start(3, 50)
  │  │  provider.stream(messages 含两轮工具结果)
  │  │    → content.delta "已完成" → yield text.delta
  │  │    → response.complete (无工具调用)
  │  │  stopCondition({ hasToolCalls: false }) → { stop: true, reason: 'natural' }
  │  │  yield loop.completed { finalText: "已完成", totalIterations: 3, reason: 'natural' }
  │  │
  │  └── generator return ──
  │
  │ 5. applyAgentLoopEvent 处理每个事件：
  │    - text.delta → draft.visibleText += delta → yield state.changed
  │    - thinking.delta → draft.thinkingText += delta → yield state.changed
  │    - tool_call.start → draft.activity = { type: 'tool', toolName } → yield state.changed
  │    - iteration.start → 重置 draft 文本，activity = 'thinking' → yield state.changed
  │    - loop.completed → completeTurn(), status = 'idle' → yield state.changed
  │    - loop.failed → failTurn(), status = 'idle' → yield state.changed
  │
  └── TUI 每收到 state.changed 就 re-render
```

### Plan Mode 数据流

```
用户输入 "/plan 帮我重构认证模块"
         │
         ▼
ChatSessionController 识别 /plan 前缀
  │ currentMode = 'plan'
  │ 构建 AgentLoopInput { mode: 'plan' }
  │
  ▼
runAgentLoop()
  │ toolRegistry = registry.filterByRisk(['read'])  // + submit_plan
  │ 循环执行，模型只能用 read 类工具调研
  │ 最终调用 submit_plan { steps: [...] }
  │ yield plan.submitted { steps }
  │ yield loop.completed { reason: 'natural' }
  │
  ▼
Controller 收到 plan.submitted → this.storedPlan = steps
TUI 展示计划步骤列表

─────

用户输入 "/do"
         │
         ▼
ChatSessionController 识别 /do 前缀
  │ currentMode = 'full'
  │ 构建 AgentLoopInput { mode: 'full', plan: this.storedPlan }
  │
  ▼
runAgentLoop()
  │ toolRegistry = 全部工具（6 个内置）
  │ 初始消息中注入计划作为 context（system 消息附带 plan steps）
  │ 模型参考计划自主执行
  │ yield loop.completed
```

## 文件组织

```
src/
├── agent/                          # 新建目录
│   ├── types.ts                    # AgentLoopEvent, AgentLoopConfig, StopDecision 等类型
│   ├── AgentLoop.ts                # runAgentLoop() 主循环 async generator
│   ├── stopCondition.ts            # checkStopCondition() 纯函数
│   ├── ToolScheduler.ts            # createBatches() + executeBatches()
│   └── index.ts                    # barrel export
├── tools/
│   ├── registry.ts                 # 修改：新增 filterByRisk() 方法
│   └── builtins/
│       └── submitPlan.ts           # 新增：submit_plan 工具定义
├── providers/
│   ├── openai/OpenAIProvider.ts    # 修改：emit 所有 tool call（不只 index 0）
│   └── anthropic/AnthropicProvider.ts  # 修改：emit 所有 tool call
├── session/
│   ├── ChatSessionController.ts    # 重构：委托 AgentLoop，applyAgentLoopEvent 映射
│   └── types.ts                    # 扩展：新增 loopProgress、plan 相关 session 状态
├── tui/
│   ├── useChatController.ts        # 小改：识别 /plan、/do 命令
│   └── components/
│       └── TranscriptPane.tsx      # 小改：显示迭代进度、计划步骤
tests/
├── unit/agent/
│   ├── AgentLoop.test.ts           # 主循环全场景测试
│   ├── stopCondition.test.ts       # 停止条件纯函数测试
│   └── ToolScheduler.test.ts       # 调度策略测试
├── helpers/
│   └── FakeProvider.ts             # 修改：支持动态多轮序列（onRequest callback）
└── e2e/
    └── (现有 smoke test 扩展)      # 多步循环 + Plan Mode 场景
```

## 风险与回滚

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Provider 多 tool.call 事件协议 | OpenAI provider 当前只 emit 第一个 tool call，多工具调用被丢弃 | 修改 Provider emit 所有 tool call。**此修改作为独立 commit**，与 Agent Loop 分离，可单独回滚验证 |
| 上下文膨胀超出模型 token 限制 | 长循环时 provider 返回 token limit 错误 | spec 明确不做压缩；错误被 loop.failed 捕获终止循环 |
| abort 在 Promise.allSettled 中的传播 | 并发执行的 read 工具可能在 abort 后继续片刻 | 所有工具共享 signal，executeToolCall 已支持 signal 检查；abort 后后续 batch 不再开始 |
| ChatSessionController 重构幅度大 | 现有 Controller 单测需要重写 | 新 AgentLoop 模块先独立测试通过，再重构 Controller；Controller 对外接口(state.changed)不变，TUI 和 E2E 影响最小 |
| E2E mock server 不支持多轮 | 当前 mock 按"一个 prompt 一个响应"映射 | 改造 mock 支持按请求中 messages 数组特征（长度或内容）返回不同响应序列 |
| Generator 消费者意外退出 | 可能有 pending 工具执行 | runAgentLoop 不持有独立资源；工具执行共享外部 signal，消费者 abort signal 即可取消一切 |
| submit_plan 被模型在非 plan mode 调用 | plan mode 外不注入该工具 | 即使模型幻觉调用也按 unknown_tool 处理 |

**回滚方式：** git revert。Agent Loop 是全新模块，Provider 修改独立 commit。出问题直接回退对应 commit。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Agent Loop 形态 | async generator 函数 | 比 class 更轻量，天然支持 for-await 消费，无状态易测试，与 Provider.stream() 风格一致 |
| 事件流机制 | yield（generator 协议） | 不引入 EventEmitter/RxJS，和现有 AsyncIterable 模式一致，无 listener 泄漏风险 |
| 多工具并发 | Promise.allSettled | 单个失败不影响其余，比 Promise.all 更健壮，结果全量返回 |
| 停止条件 | 独立纯函数 | 零依赖、极易测试、判断逻辑集中一处 |
| Plan Mode 工具过滤 | registry.filterByRisk() | 复用现有 registry 抽象，返回新实例，不污染原 registry |
| submit_plan | 作为 ToolDefinition 注册 | 复用现有工具协议，模型通过 tool call 输出计划，不需要特殊解析 |
| Provider 多 tool call | 修改 provider emit 所有 tool.call 事件 | 不改 ProviderEvent 类型定义，只改实现让它 emit 所有 index；独立 commit |
| Controller 对外接口 | 保持 state.changed 不变 | TUI 无需感知内部重构，降低改动面 |
| 未知工具处理 | ToolScheduler 直接产出 error 结果，不实际执行 | 效率更高，避免无意义的 executor 调用 |
| toolExecutionContext | 改为工厂函数注入 | 每次工具执行可能需要不同的 signal，工厂函数确保正确传播 |
| 两套 ChatMessage | 协议层统一使用 providers/types.ts 的类型，session 层的 ChatMessage 仅用于展示 | 避免同名类型混淆，AgentLoop 内部只操作 Provider 级消息 |
