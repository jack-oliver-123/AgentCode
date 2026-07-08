# 结构化系统提示体系 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/system-prompt/types.ts` | 接口定义 |
| 新建 | `src/system-prompt/modules/identity.ts` | 身份模块 |
| 新建 | `src/system-prompt/modules/constraints.ts` | 约束模块 |
| 新建 | `src/system-prompt/modules/taskMode.ts` | 任务模式模块 |
| 新建 | `src/system-prompt/modules/actions.ts` | 动作模块 |
| 新建 | `src/system-prompt/modules/tools.ts` | 工具模块 |
| 新建 | `src/system-prompt/modules/tone.ts` | 语气模块 |
| 新建 | `src/system-prompt/modules/output.ts` | 输出模块 |
| 新建 | `src/system-prompt/registry.ts` | 模块注册表 |
| 新建 | `src/system-prompt/builder.ts` | 构建器纯函数 |
| 新建 | `src/system-prompt/enhanceToolDeclarations.ts` | 工具描述后处理 |
| 新建 | `src/system-prompt/index.ts` | 桶文件 |
| 新建 | `tests/unit/system-prompt/builder.test.ts` | 构建器测试 |
| 新建 | `tests/unit/system-prompt/enhanceToolDeclarations.test.ts` | 工具增强测试 |
| 新建 | `tests/unit/system-prompt/modules.test.ts` | 模块内容约束测试 |
| 修改 | `src/providers/types.ts` | +system +UsageInfo +response.usage |
| 修改 | `src/providers/openai/OpenAIProvider.ts` | system 前置 + stream_options + usage 解析 |
| 修改 | `src/providers/anthropic/AnthropicProvider.ts` | system 映射 + cache_control + beta header + usage 解析 |
| 修改 | `src/agent/types.ts` | AgentLoopDeps +system; AgentLoopInput +reminder |
| 修改 | `src/agent/AgentLoop.ts` | 集成 system/reminder/enhanceToolDeclarations，移除 buildPlanContextMessage |
| 修改 | `src/session/ChatSessionController.ts` | turnIndex、EnvContext、构建器调用 |

## T1: 类型定义与模块内容

**文件：** `src/system-prompt/types.ts`、`src/system-prompt/modules/*.ts`
**依赖：** 无
**步骤：**
1. 创建 `src/system-prompt/types.ts`，定义 `SystemPromptModule`、`EnvContext`、`SystemPromptBuildInput`、`SystemPromptBuildOutput`、`SystemPromptBuilder` 类型
2. 创建 7 个模块文件（`modules/identity.ts` ~ `modules/output.ts`），每个导出 `export const content: string`
3. 各模块内容按 spec F2 大纲表格覆盖对应要点，每模块控制在 400-500 tokens 以内
4. 文件头加注释标注估算 token 数

**验证：** `npm run typecheck` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T2: 注册表与构建器

**文件：** `src/system-prompt/registry.ts`、`src/system-prompt/builder.ts`、`src/system-prompt/index.ts`
**依赖：** T1
**步骤：**
1. 创建 `registry.ts`，导入 7 个模块 content，组装 `defaultRegistry` 数组（含 2 个空占位可选模块）
2. 创建 `builder.ts`，实现 `buildSystemPrompt(input, registry?)` 纯函数：
   - 接受可选 `registry` 参数，默认使用 `defaultRegistry`（支持测试注入自定义注册表）
   - system 构建：`disabled` 用 `filter(Boolean)` 清除空值后过滤、过滤空 content、按 order 稳定排序、`\n\n` 连接
   - reminder 构建：env 格式化、模式指令频率控制（full 模式跳过）、plan 标签包裹（`plan.length > 0` 时才生成）、`\n` 连接
   - `reminderInterval` 内部 clamp：`Math.max(1, Math.floor(input.reminderInterval ?? 4))`
3. 创建 `index.ts` 桶文件，导出 `buildSystemPrompt`、`defaultRegistry`、类型

**验证：** `npm run typecheck` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T3: 构建器单元测试

**文件：** `tests/unit/system-prompt/builder.test.ts`、`tests/unit/system-prompt/modules.test.ts`
**依赖：** T2
**步骤：**
1. 创建 `builder.test.ts`，覆盖以下用例：
   - AC1: 7 个固定模块按 order 升序；disabled 过滤
   - AC1a: 相邻模块 `\n\n` 分隔
   - AC1b: disabled 含不存在 ID 不报错
   - AC7: push 新模块后拼装包含
   - AC7a: 空可选模块不参与拼装
   - AC6: plan mode turnIndex=0 完整版、turnIndex=1 精简版、turnIndex=4 完整版
   - AC6a: reminderInterval=2 验证
   - AC6b: full mode 无模式提醒
   - AC11: 幂等性
   - AC13: env 格式化
2. 创建 `modules.test.ts`，覆盖：
   - AC14a: 所有模块 content 不含 `${` 模板插值
   - AC9: constraints 模块包含 `<system-reminder>` 和不回复指令

**验证：** `npm test -- tests/unit/system-prompt/` 全部通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T4: 工具描述增强

**文件：** `src/system-prompt/enhanceToolDeclarations.ts`、`tests/unit/system-prompt/enhanceToolDeclarations.test.ts`
**依赖：** T1（类型）
**步骤：**
1. 创建 `enhanceToolDeclarations.ts`，实现映射逻辑：
   - 浅拷贝 declarations 数组
   - 对 edit_file/write_file/run_command 追加后缀
   - 其余工具原样返回
2. 创建测试文件，覆盖：
   - AC5: 三个工具的关键词断言
   - AC5a: 未增强工具 description 不变
   - 原始 declarations 数组未被修改

**验证：** `npm test -- tests/unit/system-prompt/enhanceToolDeclarations.test.ts` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T5: ProviderRequest 扩展与 Provider 实现

**文件：** `src/providers/types.ts`、`src/providers/openai/OpenAIProvider.ts`、`src/providers/anthropic/AnthropicProvider.ts`
**依赖：** 无（可与 T1-T4 并行）
**步骤：**
1. 在 `src/providers/types.ts` 中：
   - `ProviderRequest` 新增 `system?: string`
   - 新增 `UsageInfo` 接口
   - `ProviderEvent` 联合类型新增 `| { type: 'response.usage'; usage: UsageInfo }`
2. OpenAI Provider 修改 `createOpenAIRequestBody`：
   - 若 `request.system` 非空，在 messages 前 prepend `{ role: 'system', content: request.system }`
   - 请求体追加 `stream_options: { include_usage: true }`
   - 流式解析：最后一个 chunk 若含 `usage` 字段，yield `response.usage` 事件
3. Anthropic Provider 修改 `createAnthropicRequestBody`：
   - 若 `request.system` 非空，设置 `body.system = [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`
   - 请求头追加 `anthropic-beta: prompt-caching-2024-07-31`（若未存在）
   - 流式解析 `message_start`/`message_delta` 中的 usage，yield `response.usage` 事件

**验证：** `npm run typecheck` 通过；`npm test` 现有 Provider 测试不破坏

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T6: AgentLoop 集成

**文件：** `src/agent/types.ts`、`src/agent/AgentLoop.ts`
**依赖：** T4、T5
**步骤：**
1. 在 `src/agent/types.ts` 中：
   - `AgentLoopDeps` 新增 `system?: string`
   - `AgentLoopInput` 新增 `reminder?: string`
2. 在 `src/agent/AgentLoop.ts` 中：
   - 构建 ProviderRequest 时用 spread 模式设置 system：`...(deps.system !== undefined ? { system: deps.system } : {})`
   - 若 `input.reminder` 非空（`input.reminder && input.reminder.length > 0`），**创建 userMessage 的临时副本**并将 `<system-reminder>\n{reminder}\n</system-reminder>\n\n` 前置拼到副本的 content（不 mutate 原始 `input.userMessage`，避免 reminder 污染 providerContext 历史）
   - 调用 `enhanceToolDeclarations()` 处理 `activeRegistry.getProviderDeclarations()` 结果
   - 删除 `buildPlanContextMessage` 函数定义和调用点
   - 收到 `response.usage` ProviderEvent 时，添加显式 `case 'response.usage'`，console.debug 日志，不转发为 AgentLoopEvent
   - usage 解析做防御性类型守卫：`typeof x === 'number' ? x : undefined`

**验证：** `npm run typecheck` 通过；`npm test` 现有 AgentLoop 测试通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T7: ChatSessionController 集成

**文件：** `src/session/ChatSessionController.ts`
**依赖：** T2、T6
**步骤：**
1. 新增实例字段：`turnIndex: number`、`envContext: EnvContext`、`systemPrompt: string`、`buildSystemPromptFn: SystemPromptBuilder`
2. 构造函数中：
   - 接受可选的 `buildSystemPrompt` 参数（依赖注入，默认使用真实实现）
   - 构建 EnvContext：`os = process.platform`、`shell = detectShell()`（简单判断 process.env.SHELL 或 'powershell'）、`cwd = process.cwd()`、`date = new Date().toISOString().slice(0,10)`
   - 调用 `buildSystemPrompt({ mode, turnIndex: 0, env })` 缓存 system 字符串
3. `submitUserText` 中：
   - 每轮调用前计算 reminder：`buildSystemPromptFn({ mode, turnIndex, plan, env, reminderInterval })`
   - turnIndex++
   - 传入 `AgentLoopDeps.system` 和 `AgentLoopInput.reminder`
4. 从配置中读取 `system_prompt.reminder_interval`（可选字段，config schema 加 optional 字段）

**验证：** `npm run typecheck` 通过；`npm test` 现有 session 测试通过；手动 `npm run dev` 启动后确认 system prompt 被发送（debug log 可见）

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T8: 全量集成验证

**文件：** 无新建文件
**依赖：** T7
**步骤：**
1. 运行 `npm run typecheck` — 全量类型检查
2. 运行 `npm test` — 全量测试（包括新增和现有）
3. 运行 `npm run e2e:tmux`（如可用）— 端到端验证
4. 手动验证 plan 模式：启动 CLI，输入 `/plan` 切换，确认 reminder 中有模式标识
5. 确认 `buildPlanContextMessage` 相关代码已完全删除，grep 不到残留引用

**验证：** typecheck + test + e2e 全部通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## 执行顺序

```
T1（类型 + 模块内容）
 │
 ├─→ T2（注册表 + 构建器）→ T3（构建器测试）
 │
 └─→ T4（工具描述增强，可与 T2 并行）

T5（Provider 扩展，可与 T1-T4 并行）
 │
 └─→ T6（AgentLoop 集成，依赖 T4 + T5）
      │
      └─→ T7（Controller 集成，依赖 T2 + T6）
           │
           └─→ T8（全量验证）
```
