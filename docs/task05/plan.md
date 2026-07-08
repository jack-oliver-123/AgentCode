# 结构化系统提示体系 Plan

## 方案选择摘要

- 候选方案来源：3 个子代理分别从架构一致性、最小可行、测试与回滚角度提出。
- 最终选择：架构一致性方案，吸收最小可行方案的"全部可选字段"策略和测试与回滚方案的 4 层回滚设计。
- 选择理由：三者核心设计高度一致（纯函数构建器 + 数据驱动注册表 + Provider 可选字段扩展），架构一致性方案在命名规范和模块交互描述上最贴合现有代码风格。
- 丢弃说明：三方案无实质性冲突，差异仅在命名和强调点上；已合并各方的独特贡献（回滚层级、测试影响矩阵）。

## 架构概览

新增 `src/system-prompt/` 模块，与 `src/agent/`、`src/providers/`、`src/session/` 平行。职责单一：生成系统提示文本和每轮 reminder。

```
src/
├── system-prompt/              ← 全新模块
│   ├── types.ts                ← 接口定义
│   ├── builder.ts              ← buildSystemPrompt 纯函数
│   ├── registry.ts             ← 模块注册表（数据数组）
│   ├── enhanceToolDeclarations.ts  ← F6 工具描述后处理
│   ├── index.ts                ← 桶文件导出
│   └── modules/                ← 固定模块内容常量
│       ├── identity.ts         ← order: 100
│       ├── constraints.ts      ← order: 200
│       ├── taskMode.ts         ← order: 250
│       ├── actions.ts          ← order: 300
│       ├── tools.ts            ← order: 400
│       ├── tone.ts             ← order: 500
│       └── output.ts           ← order: 600
├── providers/
│   └── types.ts                ← ProviderRequest +system; ProviderEvent +response.usage
├── agent/
│   ├── types.ts                ← AgentLoopDeps +system; AgentLoopInput +reminder
│   └── AgentLoop.ts            ← 集成 system/reminder，移除 buildPlanContextMessage
└── session/
    └── ChatSessionController.ts ← 维护 turnIndex/EnvContext，调用构建器
```

命名规范：
- 目录名 kebab-case（`system-prompt`），与 `providers/shared`、`tools/builtins` 一致
- 文件名 camelCase（`taskMode.ts`），与项目 `.ts` 文件命名一致
- 函数名 camelCase（`buildSystemPrompt`、`enhanceToolDeclarations`）

## 核心数据结构

### SystemPromptModule（注册表条目）

```typescript
export interface SystemPromptModule {
  id: string;       // 唯一标识
  order: number;    // 拼装顺序号
  content: string;  // 模块文本（空字符串 = 占位不拼装）
}
```

### EnvContext（环境上下文）

```typescript
export interface EnvContext {
  os: string;     // process.platform
  shell: string;  // 'bash' | 'powershell' | ...
  cwd: string;    // process.cwd()
  date: string;   // ISO 日期字符串
}
```

### SystemPromptBuildInput / Output（构建器 I/O）

```typescript
export interface SystemPromptBuildInput {
  mode: 'full' | 'plan';
  turnIndex: number;
  plan?: PlanStep[];
  env?: EnvContext;
  disabled?: string[];
  reminderInterval?: number;  // 默认 4，最小 1
}

export interface SystemPromptBuildOutput {
  system: string;   // 会话内稳定
  reminder: string; // 每轮计算，可能为空
}

export type SystemPromptBuilder = (input: SystemPromptBuildInput) => SystemPromptBuildOutput;
```

### ProviderRequest 扩展

```typescript
export interface ProviderRequest {
  // ...现有字段不变...
  system?: string;  // 新增：系统提示文本
}
```

### ProviderEvent 扩展

```typescript
// 新增到联合类型
| { type: 'response.usage'; usage: UsageInfo }

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cachedTokens?: number;
}
```

### AgentLoop 接口扩展

```typescript
export interface AgentLoopDeps {
  // ...现有字段不变...
  system?: string;  // 新增
}

export interface AgentLoopInput {
  // ...现有字段不变...
  reminder?: string;  // 新增
}
```

## 模块设计

### system-prompt/builder.ts

**职责：** 纯函数，接收 BuildInput 返回 BuildOutput。

**函数签名：**
```typescript
export function buildSystemPrompt(
  input: SystemPromptBuildInput,
  registry?: SystemPromptModule[]  // 默认使用 defaultRegistry，测试时可传入自定义数组
): SystemPromptBuildOutput;
```

**system 构建逻辑：**
1. 从 registry 参数（或 defaultRegistry）获取模块数组
2. 过滤 disabled 中的模块 ID（不存在的 ID 静默忽略）
3. 过滤空 content 模块
4. 按 order 升序稳定排序（相同 order 按注册顺序）
5. 以 `\n\n` 连接

**reminder 构建逻辑：**
1. 环境上下文（env 非空时）：`OS: {os} | Shell: {shell} | CWD: {cwd} | Date: {date}`
2. 模式指令（mode !== 'full' 时）：按频率控制 → 完整版或精简版
3. plan 上下文（plan 非空且 `plan.length > 0` 时）：`<active-plan>...</active-plan>`（空数组不生成标签）
4. 以 `\n` 连接非空部分

**防御性处理：**
- `reminderInterval` 内部 clamp：`const interval = Math.max(1, Math.floor(input.reminderInterval ?? 4))`
- `disabled` 过滤前用 `filter(Boolean)` 清除空字符串/非法值

**依赖：** registry.ts（模块数组）。无外部 IO。

### system-prompt/registry.ts

**职责：** 导出默认模块注册表数组。

```typescript
import { content as identityContent } from './modules/identity.js';
import { content as constraintsContent } from './modules/constraints.js';
// ... 其余模块 ...

export const defaultRegistry: SystemPromptModule[] = [
  { id: 'identity', order: 100, content: identityContent },
  { id: 'constraints', order: 200, content: constraintsContent },
  { id: 'task-mode', order: 250, content: taskModeContent },
  { id: 'actions', order: 300, content: actionsContent },
  { id: 'tools', order: 400, content: toolsContent },
  { id: 'tone', order: 500, content: toneContent },
  { id: 'output', order: 600, content: outputContent },
  { id: 'custom-instructions', order: 700, content: '' },
  { id: 'memory', order: 800, content: '' },
];
```

### system-prompt/enhanceToolDeclarations.ts

**职责：** 对工具声明数组做后处理，追加行为规则后缀。

```typescript
const SUFFIXES = new Map([
  ['edit_file', '\n\nImportant: 调用前必须先用 read_file 读取目标文件。'],
  ['write_file', '\n\nImportant: 仅用于创建新文件；修改已有文件请用 edit_file。'],
  ['run_command', '\n\nImportant: 如果存在专用工具能完成任务，优先使用专用工具而非 run_command。'],
]);

export function enhanceToolDeclarations(
  declarations: ProviderToolDeclaration[]
): ProviderToolDeclaration[] {
  return declarations.map((decl) => {
    const suffix = SUFFIXES.get(decl.name);
    if (suffix === undefined) return decl;
    return { ...decl, description: `${decl.description}${suffix}` };
  });
}
```

浅拷贝声明后修改，不污染原始 registry 数据。

### system-prompt/modules/*.ts

**职责：** 每个文件导出 `export const content: string`，纯文本常量。

各模块内容要点（详见 spec F2 大纲表格）：
- identity: 产品名、角色、能力概述
- constraints: 安全边界、workspace 限制、system-reminder 标签处理指令
- taskMode: full/plan 模式行为规则
- actions: 先读后改、最小改动、改完验证
- tools: 工具选择优先级、编辑前必读
- tone: 简洁直接、中文为主
- output: 代码块格式、聚焦结果

### Providers 改动

**Anthropic Provider：**
- `createAnthropicRequestBody` 中：若 `request.system` 非空，设置 `body.system = [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`
- 请求头追加 `anthropic-beta: prompt-caching-2024-07-31`（若未存在）
- 流式解析 `message_start`/`message_delta` 中的 usage，yield `response.usage` 事件

**OpenAI Provider：**
- `createOpenAIRequestBody` 中：若 `request.system` 非空，在 messages 前 prepend `{ role: 'system', content }`
- 请求体追加 `stream_options: { include_usage: true }`
- 流式解析最后一个 chunk 的 `usage` 字段，yield `response.usage` 事件

### AgentLoop 改动

1. 从 `deps.system` 获取 system，设到 `ProviderRequest.system`（用 spread 模式规避 `exactOptionalPropertyTypes`）
2. 从 `input.reminder` 获取 reminder，非空时**创建 userMessage 的临时副本**并前置拼到副本的 content（不 mutate 原始 `input.userMessage` 对象，避免 reminder 污染 providerContext 历史消息）
3. 调用 `enhanceToolDeclarations()` 处理工具声明
4. 删除 `buildPlanContextMessage` 调用及相关逻辑
5. 收到 `response.usage` 事件时 debug 日志，不转发为 AgentLoopEvent
6. usage 解析做防御性类型守卫：每个字段用 `typeof x === 'number' ? x : undefined` 确保非数字值不传播

### ChatSessionController 改动

1. 构造时构建 `EnvContext`：`{ os: process.platform, shell: detectShell(), cwd: process.cwd(), date: new Date().toISOString().slice(0,10) }`
2. 构造时调用 `buildSystemPrompt({ mode, turnIndex: 0, env })` 缓存 system 字符串
3. 新增 `turnIndex` 实例变量（从 0 开始，每次 submitUserText +1）
4. 每轮调用前获取 reminder，传入 AgentLoopInput
5. 构建器函数通过构造函数参数注入（便于测试 mock）
6. `reminderInterval` 从配置读取后传入 buildInput

## 模块交互

```
初始化:
  ChatSessionController
    → buildSystemPrompt({ mode, turnIndex:0, env })
    → system 缓存到实例
    → system 传入 AgentLoopDeps

每轮请求:
  ChatSessionController
    → buildSystemPrompt({ mode, turnIndex, plan, env, reminderInterval })
    → reminder 传入 AgentLoopInput
    → AgentLoop:
        1. request.system = deps.system
        2. userMsg.content = <system-reminder>{reminder}</system-reminder> + originalContent
        3. request.tools = enhanceToolDeclarations(registry.getProviderDeclarations())
        4. provider.stream(request)
    → Provider:
        Anthropic: system → [{text, cache_control}] + beta header
        OpenAI: system → messages[0]{role:'system'} + stream_options
    → response.usage 事件 → AgentLoop debug log
```

## 文件组织

```
src/system-prompt/
├── types.ts                       # 接口定义
├── builder.ts                     # buildSystemPrompt 纯函数
├── registry.ts                    # 默认模块注册表
├── enhanceToolDeclarations.ts     # 工具描述后处理
├── index.ts                       # 桶文件
└── modules/
    ├── identity.ts
    ├── constraints.ts
    ├── taskMode.ts
    ├── actions.ts
    ├── tools.ts
    ├── tone.ts
    └── output.ts

tests/unit/system-prompt/
├── builder.test.ts                # 构建器纯函数测试
├── enhanceToolDeclarations.test.ts # 工具增强测试
└── modules.test.ts                # 模块内容约束测试
```

## 风险与回滚

### 回滚分层

改动分为 4 个独立可回滚层级：

| 层级 | 内容 | 回滚方式 |
|------|------|---------|
| L1 | `src/system-prompt/` 整个模块 | 删除目录 + Controller 不调用构建器 |
| L2 | Provider system 字段映射 | system 为可选，不传时行为不变 |
| L3 | `response.usage` 事件 | AgentLoop 中忽略即可 |
| L4 | 工具描述增强 | 移除 enhanceToolDeclarations 调用 |

每层独立可 revert，建议按层级分 commit。

### 风险矩阵

| 风险 | 影响 | 缓解 |
|------|------|------|
| `exactOptionalPropertyTypes` 赋值报错 | 编译失败 | 新字段用 spread 模式赋值 |
| OpenAI `stream_options` 在兼容代理不支持 | 4xx 或静默忽略 | 必要时条件开启 |
| 删除 `buildPlanContextMessage` 改变 plan 行为 | plan 效果退化 | E2E 验证 plan 模式 |
| ProviderEvent 新增导致 exhaustive switch 报错 | 编译失败 | AgentLoop 内部消化，不转发为 AgentLoopEvent |
| 现有测试 mock 缺少新字段 | 编译失败 | 所有新字段 optional，现有 mock 无需改动 |
| 模块内容超 token 预算 | 缓存效率降低 | 文件头注释标注估算 token 数 |
| Anthropic beta header 与用户自定义 headers 冲突 | header 被覆盖 | 框架 header 放前，用户 headers 在后可覆盖 |

### 安全边界

- 模块内容为编译时常量，不含 `${}`、不读环境变量、不含 API key
- EnvContext 仅含 os/shell/cwd/date 公开信息
- response.usage 为 debug 级别日志，不在 TUI 展示
- constraints 模块包含 system-reminder 标签处理指令

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 构建器设计 | 纯函数 | 幂等、无副作用、易测试，与项目 `stopCondition.ts` 风格一致 |
| 注册表形式 | 数据数组 | 与 StaticToolRegistry 数据驱动模式一致；新增模块 O(1) |
| 新字段策略 | 全部 optional | 零回归风险，现有 mock/测试不改即通过 |
| system 字段赋值 | spread 模式 | 规避 `exactOptionalPropertyTypes` 约束 |
| reminder 注入位置 | userMessage.content 前置 | 不产生独立消息，不破坏角色交替 |
| response.usage 处理 | AgentLoop 内 debug log，不转发 | 不影响 AgentLoopEvent 联合类型，不触发 controller exhaustive check |
| 工具增强位置 | AgentLoop 辅助函数 | 工具注册表保持纯净，增强逻辑可独立测试 |
| 模块文件命名 | camelCase（taskMode.ts） | 匹配项目现有 .ts 文件命名风格 |
| 构建器注入方式 | ChatSessionController 构造函数参数 | 便于测试 mock，与现有 deps 注入模式一致 |
