# 结构化系统提示体系 Spec

## 术语定义

- **system 字段**：Provider 请求中承载系统提示的位置。Anthropic 为顶层 `system` 参数（文本块数组，支持 `cache_control`）；OpenAI 为 `messages[0]` with `role: 'system'`。
- **system-reminder**：带 `<system-reminder>` XML 标签的文本，与当前轮的用户消息合并为一条 `role: 'user'` 消息发送（标签文本在前，用户文本在后），用于注入动态信息。不产生额外的独立消息，不破坏角色交替。
- **固定模块**：内容在单次会话生命周期内不变的系统提示组成单元，拼入 system 字段参与缓存。
- **可选模块**：可能为空或缺席的模块。其中稳定类（自定义指令、长期记忆）在会话初始化时确定后拼入 system 字段尾部参与缓存；动态类（环境信息、会话级开关）通过 system-reminder 注入。
- **拼装顺序**：模块在最终 prompt 文本中的排列位置（序号越小越靠前）。此顺序同时作为未来 token 截断时的保留优先级，但本阶段不实现自动截断。
- **模块间分隔**：相邻模块之间以一个空行（即两个连续换行符 `\n\n`）分隔。

## 背景

当前 AgentCode 没有任何系统提示——`MessageRole` 类型里不存在 `'system'` 角色，Provider 发出去的请求直接从 user/assistant 消息开始。模型在"裸跑"状态下完成任务，缺乏身份定义、行为约束、工具使用规范和安全边界。

现有架构中：
- `ProviderRequest` 只有 `messages` 字段，无 `system` 字段
- `AgentLoopInput` 和 `AgentLoopDeps` 都没有系统提示相关参数
- Provider 实现（OpenAI/Anthropic）均未处理 system role
- 工具描述仅通过 `ProviderToolDeclaration` 的 `description` 字段传递，没有额外的使用规范
- `buildPlanContextMessage` 当前以独立 user 消息注入 plan 上下文

## 目标

- 构建模块化的系统提示体系，按职责拆分为独立模块，支持拼装顺序排列和未来扩展
- 稳定内容走 Anthropic 显式缓存通道（`cache_control` breakpoint），降低延迟和成本；OpenAI 侧保持前缀稳定以享受隐式缓存
- 动态信息通过 system-reminder 机制注入（与用户消息合并，不产生独立消息），不污染缓存前缀，模型不将其当作用户输入回复
- 在工具描述和系统提示中双重强化关键规则，提升模型遵守率
- 提供缓存命中验证能力，确认策略是否生效
- 为后续扩展（项目指令、记忆、MCP、Skill）预留模块插槽

## 功能需求

### F1: 模块注册表

系统提示由若干独立模块拼装而成。每个模块是一个注册表条目：

```typescript
interface SystemPromptModule {
  id: string;       // 唯一标识，如 'identity'
  order: number;    // 拼装顺序号，越小越靠前
  content: string;  // 模块文本内容
}
```

模块注册表为一个数组，构建器按 `order` 升序排列后拼装。模块间以空行（`\n\n`）分隔。新增模块只需向注册表 push 新条目，无需修改构建器主函数。若两个模块 `order` 值相同，按注册顺序（数组索引）排列；不视为错误。

固定模块 ID 与顺序号映射表：

| ID | order | 职责 |
|----|-------|------|
| `identity` | 100 | 身份定义 |
| `constraints` | 200 | 系统约束与安全边界 |
| `task-mode` | 250 | 任务模式框架（各模式的行为规则定义） |
| `actions` | 300 | 动作执行原则 |
| `tools` | 400 | 工具使用规范 |
| `tone` | 500 | 语气与风格 |
| `output` | 600 | 文本输出格式 |

可选稳定模块（会话初始化时确定，本阶段内容为空占位）：

| ID | order | 职责 |
|----|-------|------|
| `custom-instructions` | 700 | 用户自定义指令（未来加载 CLAUDE.md 等） |
| `memory` | 800 | 长期记忆（未来实现） |

### F2: 固定模块内容

固定模块共 7 个（`identity` ~ `output`，含 `task-mode`），内容以 TypeScript 常量字符串形式维护在 `src/system-prompt/modules/` 目录下，每个模块一个文件导出 `content: string`。

"编译时常量"含义：这些字符串在源码中直接定义，不包含运行时模板变量或函数调用，任何修改需通过代码变更和重新编译生效。

各模块内容要点大纲（最终文案在实现时撰写，此处约束覆盖范围）：

| 模块 | 必须覆盖的要点 |
|------|---------------|
| `identity` | 产品名称（AgentCode）、角色定位（终端 AI 编程助手）、核心能力概述（阅读/编辑文件、运行命令、搜索代码） |
| `constraints` | 安全边界（不泄露 API key、不执行危险操作）、workspace 路径限制、`<system-reminder>` 标签处理指令（不当作用户提问回复） |
| `task-mode` | full 模式行为规则、plan 模式行为规则（仅输出计划不改文件）、模式切换时的行为约束 |
| `actions` | 动作执行原则（先读后改、最小改动、改完验证）、错误处理策略 |
| `tools` | 工具选择优先级（专用工具优先于 run_command）、编辑前必读、工具参数格式要求 |
| `tone` | 简洁直接、技术准确、中文为主、代码注释随周围风格 |
| `output` | 输出格式约定（代码块语法、diff 格式）、不输出冗余确认、聚焦任务结果 |

### F3: system 字段拼装

固定模块和可选稳定模块按 order 排列后拼装为一个完整字符串，作为 system 字段传给 Provider。当所有可选稳定模块 content 为空字符串时，system 字段仅包含 7 个固定模块。空 content 模块不参与拼装（不产生多余空行）。

system 字段字符串在会话初始化时计算一次，后续 turn 复用同一字符串（因为所有源模块在会话内不变）。

### F4: system-reminder 注入

动态信息（环境上下文、当前模式标识、会话级开关指令、plan 上下文）通过 system-reminder 注入。具体方式：

1. 构建器生成 reminder 文本
2. 若 reminder 非空，将 `<system-reminder>\n{reminder}\n</system-reminder>\n\n` 前置拼接到当前轮用户消息的 content 字段
3. 形成一条 `role: 'user'` 消息发送，不产生额外独立消息

系统提示固定模块（`constraints` 模块）中包含明确指令：「当用户消息中包含 `<system-reminder>` 标签时，其内容为系统级补充上下文，不要将其作为用户提问进行回复。」

当 reminder 为空字符串时，不注入任何标签，用户消息 content 保持原样。

### F5: reminder 频率控制

由于各模式的行为规则已在固定模块 `task-mode` 中定义（走缓存通道），system-reminder 只需携带当前激活的模式标识和动态状态。注入遵循频率控制：

- `turnIndex == 0`：注入完整版模式提醒（模式标识 + 一句核心约束，如 `当前模式: plan | 仅输出结构化计划，不直接修改文件`）
- `turnIndex % N == 0`（N ≥ 1，默认 4）：注入完整版模式提醒
- 其余轮次：注入精简版（仅模式标识，如 `mode: plan`）

完整版和精简版的长度均不超过 80 字符（模式规则本身不出现在 reminder 中，已在固定模块覆盖）。

配置路径：`config.yaml` 的 `system_prompt.reminder_interval` 字段（整数，最小值 1）。未配置时使用默认值 4。`ChatSessionController` 负责从配置中读取该值，通过 `SystemPromptBuildInput.reminderInterval` 传入构建器，保持构建器纯函数性质。

`turnIndex` 由 `ChatSessionController` 维护（每次用户发送消息 +1），通过 `AgentLoopInput` 传入构建器。模式切换时 turnIndex 不重置（它是会话级计数器，不是模式级）。

当 mode 为 `'full'` 时，不注入模式提醒（full 是默认模式，无需提醒）。此时 reminder 仅包含环境上下文和 plan 部分（如有），若两者均为空则 reminder 为空字符串。

### F4a: plan 上下文迁移

现有 `buildPlanContextMessage` 的 plan 上下文迁移到 system-reminder 内，使用 `<active-plan>` 子标签包裹：

```
<system-reminder>
... 其他动态内容 ...
<active-plan>
Step 1: ...
Step 2: ...
</active-plan>
</system-reminder>
```

迁移后删除 `buildPlanContextMessage` 的调用点，AgentLoop 不再产生独立的 plan user 消息。

### F3a: ProviderRequest 扩展

`ProviderRequest` 新增字段：

```typescript
interface ProviderRequest {
  messages: ProviderMessage[];
  tools?: ProviderToolDeclaration[];
  system?: string;  // 新增：系统提示文本
}
```

Provider 实现映射规则：

**Anthropic Provider：**
- 将 `system` 字符串映射为请求体顶层 `system` 数组：`[{ type: 'text', text: systemString, cache_control: { type: 'ephemeral' } }]`
- 请求头需包含 `anthropic-beta: prompt-caching-2024-07-31`（如果该 header 尚未存在）
- 当 `ProviderRequest.system` 为 undefined 或空字符串时，不设置 `system` 字段（与当前行为一致）

**OpenAI Provider：**
- 将 `system` 字符串作为 `{ role: 'system', content: systemString }` 前置到 messages 数组
- OpenAI 自动前缀缓存对长度 >1024 tokens 且前缀稳定的内容生效，无需额外配置
- 当 `ProviderRequest.system` 为 undefined 或空字符串时，不插入 system 消息

### F6: 工具描述增强

AgentLoop 在调用 `ToolRegistry.getProviderDeclarations()` 获取声明后，对返回的声明数组做后处理，追加行为规则后缀到指定工具的 description。

增强逻辑不在 ToolRegistry 内部，而是在 AgentLoop 或其辅助函数中完成，确保工具注册表保持纯净。

规则映射（仅以下工具被增强，其余不变）：

| 工具 ID | 追加后缀 |
|---------|---------|
| `edit_file` | `\n\nImportant: 调用前必须先用 read_file 读取目标文件。` |
| `write_file` | `\n\nImportant: 仅用于创建新文件；修改已有文件请用 edit_file。` |
| `run_command` | `\n\nImportant: 如果存在专用工具（read_file/write_file/edit_file/glob_files/search_code）能完成任务，优先使用专用工具而非 run_command。` |

### F7: 缓存用量事件

Provider 层解析 API 响应中的缓存和用量字段，通过新增 `response.usage` 事件暴露：

```typescript
// 新增到 ProviderEvent 联合类型
interface UsageEvent {
  type: 'response.usage';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;  // Anthropic: cache_creation_input_tokens
    cacheReadTokens?: number;      // Anthropic: cache_read_input_tokens
    cachedTokens?: number;         // OpenAI: usage.prompt_tokens_details.cached_tokens
  };
}
```

**Anthropic 解析**：从流式 `message_start` 事件的 `message.usage` 和 `message_delta` 事件的 `usage` 对象提取 `cache_creation_input_tokens` 和 `cache_read_input_tokens`。以最后一次出现的值为准。

**OpenAI 解析**：请求时需在请求体中设置 `stream_options: { include_usage: true }`，使流式最后一个 chunk 包含 `usage` 字段。从 `usage.prompt_tokens_details.cached_tokens` 提取缓存命中数。

当 Provider 响应中不包含缓存相关字段时，对应可选字段为 undefined，事件正常发出（至少包含 inputTokens/outputTokens）。当响应完全不包含 usage 信息时（如流式中间 chunk），不发出该事件。

AgentLoop 接收到 `response.usage` 事件后暂仅做日志记录（debug 级别），不影响流程控制。

### F8: 构建器主入口

```typescript
interface EnvContext {
  os: string;     // e.g. 'win32', 'darwin', 'linux'
  shell: string;  // e.g. 'bash', 'powershell'
  cwd: string;    // 当前工作目录
  date: string;   // ISO 日期字符串，如 '2026-07-08'
}

interface SystemPromptBuildInput {
  mode: 'full' | 'plan';
  turnIndex: number;
  plan?: PlanStep[];
  env?: EnvContext;
  disabled?: string[];        // 要禁用的模块 ID 列表
  reminderInterval?: number;  // 频率控制间隔 N，默认 4，最小 1
}

interface SystemPromptBuildOutput {
  system: string;   // 所有启用模块拼装的完整文本（会话内稳定）
  reminder: string; // 当前轮 system-reminder 文本（可能为空）
}

function buildSystemPrompt(input: SystemPromptBuildInput): SystemPromptBuildOutput;
```

**system 构建**：从注册表过滤掉 `disabled` 中列出的模块 ID，按 order 升序排列，将非空 content 以 `\n\n` 连接。

**reminder 构建**：
1. 环境上下文（env 非空时）：格式为 `OS: {os} | Shell: {shell} | CWD: {cwd} | Date: {date}`
2. 模式指令：按 F5 频率控制规则决定完整版或精简版
3. plan 上下文（plan 非空时）：`<active-plan>...</active-plan>` 包裹
4. 以上各部分以 `\n` 连接，任何部分为空则跳过

幂等性：相同输入调用多次，输出完全一致。构建器为纯函数，无副作用。

### F9: 模块内容为纯文本常量

固定模块内容为源码中的 TypeScript `const` 字符串，例如：

```typescript
// src/system-prompt/modules/identity.ts
export const content = `你是 AgentCode，一个运行在终端中的 AI 编程助手。
你帮助开发者完成编码任务，包括阅读和编辑文件、运行命令、搜索代码。`;
```

不包含模板字面量插值（`${}`）、函数调用或运行时变量引用。修改内容需更改源文件并重新构建。

### F10: AgentLoop 集成

AgentLoop 在构建 ProviderRequest 时：

1. 从 `AgentLoopDeps` 获取预构建的 `system` 字符串，设置到 `ProviderRequest.system`
2. 从 `AgentLoopInput` 获取当前轮的 `reminder` 字符串
3. 若 reminder 非空，将 `<system-reminder>\n{reminder}\n</system-reminder>\n\n` + 原始 userMessage.content 拼为新的 content
4. 不再调用 `buildPlanContextMessage` 插入独立 plan 消息

字段归属：
- `system: string` → `AgentLoopDeps`（会话级稳定，初始化一次）
- `reminder: string` → `AgentLoopInput`（每轮计算）

### F11: 会话控制器集成

`ChatSessionController` 在调用 AgentLoop 前：

1. 会话初始化时调用 `buildSystemPrompt({ mode, turnIndex: 0, ... })` 获取 `system` 字符串，存入 deps
2. 每轮调用前，以当前 `turnIndex` 调用构建器获取 `reminder`，传入 `AgentLoopInput`
3. `turnIndex` 在每次用户发送消息时递增（从 0 开始）
4. 模式切换时不重置 turnIndex，但需重新调用构建器获取新的 reminder（因为 mode 参数变了）
5. `reminderInterval` 从配置（`config.yaml` 的 `system_prompt.reminder_interval`）读取后传入 `SystemPromptBuildInput`
6. `EnvContext` 由 `ChatSessionController` 在会话初始化时构建：`os` 取 `process.platform`，`shell` 检测当前 shell 环境（如 `'bash'`/`'powershell'`），`cwd` 取 `process.cwd()`，`date` 取当日 ISO 日期字符串。构建后作为固定值传入每轮 buildInput（会话内不变）

集成缝隙（seam）设计：`ChatSessionController` 通过依赖注入获取构建器函数（`buildSystemPrompt`），便于测试时替换为 mock。

## 非功能需求

- N1: 固定模块拼装后的总长度目标不超过 3500 tokens（以 cl100k_base 分词估算），硬上限 4000 tokens。本阶段通过人工审查模板文本控制，不实现运行时计数。每个固定模块建议控制在 400-500 tokens 以内
- N2: 模块拼装过程无外部 IO，纯内存计算，延迟可忽略
- N3: 同一模式下连续对话中，Anthropic 侧第二轮起 system 前缀应命中缓存（`cache_read_input_tokens > 0`）
- N4: system-reminder 通过与用户消息合并注入，不产生独立消息，天然保证不破坏工具调用/结果消息的配对关系和角色交替
- N5: 新增模块只需向注册表数组 push 新条目（`{ id, order, content }`），构建器遍历注册表按 order 排序后拼装，无需修改构建器函数体

## 不做的事

- 不实现项目指令文件（如 CLAUDE.md）的自动加载和解析——留给后续任务
- 不实现自动记忆系统——留给后续任务
- 不接入真实 MCP 服务——留给后续任务
- 不实现 Skill 系统——留给后续任务
- 不构建自动化评估框架——本阶段用人工对比做定性评估
- 不实现 token 计数或自动截断——本阶段通过人工控制模板长度保证 N1
- 不修改现有工具的执行逻辑——只在声明输出时追加描述规则
- 不实现模式切换时的 system 字段重建——各模式的行为规则在固定模块 `task-mode` 中统一定义（覆盖所有模式），当前激活模式标识通过 system-reminder 动态注入，模式切换只影响 reminder 内容不影响 system 字段

## 验收标准

### 模块拼装

- AC1: 系统提示由 7 个固定模块按 order 升序生成；传入 `{ disabled: ['identity'] }` 时，输出不包含 identity 模块内容，其余模块顺序和分隔不变
- AC1a: 相邻模块间恰好以 `\n\n` 分隔（不多不少）
- AC1b: `disabled` 包含不存在的模块 ID（如 `'nonexistent'`）时不报错，输出与不传 disabled 时一致
- AC7: 在模块注册表中 push `{ id: 'test-custom', order: 800, content: 'test content' }` 后，拼装输出末尾包含 'test content'，且未修改构建器函数代码
- AC7a: 所有可选稳定模块 content 为空时，拼装结果仅含 7 个固定模块内容，无尾部空行

### Provider 集成

- AC2: ProviderRequest 的 `system` 字段为非空字符串。Anthropic Provider 构建请求体时映射为 `system: [{ type: 'text', text: ..., cache_control: { type: 'ephemeral' } }]`，且请求包含 `anthropic-beta` header。OpenAI Provider 将其作为 `{ role: 'system', content: ... }` 前置（单元测试 mock 拦截验证）
- AC2a: 当 `ProviderRequest.system` 为 undefined 时，Anthropic 不设置 `system` 字段，OpenAI 不插入 system 消息（向后兼容）

### system-reminder 注入

- AC3: 当 reminder 非空时，AgentLoop 发出的 ProviderRequest 中用户消息 content 以 `<system-reminder>` 开头，以 `</system-reminder>` 结束标签后接用户原始文本
- AC3a: 当 reminder 为空字符串时，用户消息 content 不包含 `<system-reminder>` 标签（即不注入空标签）
- AC9: constraints 模块文本包含字符串 `<system-reminder>` 和「不要将其作为用户提问进行回复」（或语义等价表述）

### 频率控制

- AC6: 构建器以 `{ mode: 'plan', turnIndex: 0 }` 调用时，reminder 包含完整版模式提醒（模式标识 + 核心约束，长度 ≤ 80 字符）；以 `{ mode: 'plan', turnIndex: 1 }` 调用时返回精简版（仅模式标识，如 `mode: plan`）；以 `{ mode: 'plan', turnIndex: 4 }` 调用时（默认 N=4）再次返回完整版
- AC6a: 传入 `{ reminderInterval: 2 }` 时，turnIndex 2 返回完整版、turnIndex 1 返回精简版
- AC6b: 构建器以 `{ mode: 'full', turnIndex: 0 }` 调用时，reminder 不包含模式提醒部分（full 为默认模式无需提醒）；仅包含环境上下文和 plan（如有）

### 缓存用量

- AC4: Provider 解析 mock 响应中的 `cache_read_input_tokens`（Anthropic）或 `cached_tokens`（OpenAI）后，发出 `response.usage` 事件，事件 usage 对象包含对应的缓存数值字段
- AC4a: 当 mock 响应不含缓存字段时，事件仍正常发出，缓存相关字段为 undefined，不报错

### 工具描述增强

- AC5: `getProviderDeclarations()` 返回经 AgentLoop 后处理后的 `edit_file` 声明 description 包含「read_file」关键词；`write_file` 包含「edit_file」关键词；`run_command` 包含「专用工具」关键词
- AC5a: 未列入增强映射的工具（如 `read_file`）的 description 保持原样不变

### plan 迁移

- AC10: AgentLoop 构建的 ProviderRequest messages 中不再出现由 `buildPlanContextMessage` 产生的独立 plan user 消息；plan 内容出现在用户消息 content 的 `<active-plan>` 标签内

### 构建器幂等性

- AC11: 相同 `SystemPromptBuildInput` 调用 `buildSystemPrompt` 两次，两次返回的 `system` 和 `reminder` 字符串完全相等（`===`）

### 集成与回归

- AC8: `npm run typecheck` 通过，`npm test` 现有用例不被破坏
- AC12: `ChatSessionController` 通过依赖注入获取构建器函数，单元测试可用 mock 构建器替换验证集成

### 环境上下文格式

- AC13: 传入 `{ env: { os: 'win32', shell: 'powershell', cwd: '/tmp/project', date: '2026-07-08' } }` 时，reminder 包含 `OS: win32 | Shell: powershell | CWD: /tmp/project | Date: 2026-07-08`

### 模块文件结构

- AC14: `src/system-prompt/modules/` 目录下每个固定模块对应一个文件（identity.ts、constraints.ts、task-mode.ts、actions.ts、tools.ts、tone.ts、output.ts），每个文件导出 `content` 字符串常量
- AC14a: 所有模块文件的 `content` 导出值不包含 `${` 模板插值语法（可通过静态检查或正则验证）

### OpenAI 流式 usage

- AC15: OpenAI Provider 发出的流式请求体包含 `stream_options: { include_usage: true }` 字段
