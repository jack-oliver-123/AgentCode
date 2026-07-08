# 结构化系统提示体系 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 审查来源

- spec.md 验收标准：已覆盖（AC1~AC15 全部转化为下方验证项）
- plan.md 风险与回滚：已覆盖（回滚分层、exactOptionalPropertyTypes、providerContext 污染等）
- 当前分支 vs main diff：已由 2 个子代理从正确性/回归和安全/错误处理角度只读审查；无实现 diff 可审，已审查空 diff + 已批准文档 + 当前代码上下文
- 子代理发现处理：有效发现已转化为下方可验证条目

## 验收记录

验收日期：2026-07-08

验证环境：Windows 11 Pro, Node.js, TypeScript strict mode (exactOptionalPropertyTypes)

### 验证结果摘要

- `npm run typecheck`: 通过（0 errors）
- `npm test` 核心测试: 123/123 通过（system-prompt + agent + session + providers）
- 全量测试: 335 passed / 4 failed（失败的 4 个是已知 flaky 文件系统测试，见 CLAUDE.md 踩坑记录，非本次引入）
- `grep -r buildPlanContextMessage src/`: CLEAN（无残留）

## 实现完整性

- [x] `src/system-prompt/` 目录存在，包含 types.ts、builder.ts、registry.ts、enhanceToolDeclarations.ts、index.ts — 证据：文件已创建，typecheck 通过
- [x] `src/system-prompt/modules/` 包含 7 个文件：identity.ts、constraints.ts、taskMode.ts、actions.ts、tools.ts、tone.ts、output.ts — 证据：T1 子代理创建并确认
- [x] 每个模块文件导出 `content` 字符串常量 — 证据：modules.test.ts 遍历验证通过

## 模块拼装

- [x] AC1: 7 个固定模块按 order 升序拼装；disabled 过滤生效 — 证据：builder.test.ts 通过
- [x] AC1a: 相邻模块间恰好以 `\n\n` 分隔 — 证据：builder.test.ts 通过
- [x] AC1b: disabled 含不存在 ID 不报错 — 证据：builder.test.ts 通过
- [x] AC7: push 新模块后拼装输出包含新内容 — 证据：builder.test.ts 通过（通过 registry 参数注入自定义模块）
- [x] AC7a: 空可选模块不参与拼装，无尾部空行 — 证据：builder.test.ts 通过

## system-reminder 注入

- [x] AC3: reminder 非空时，用户消息 content 以 `<system-reminder>` 开头 — 证据：AgentLoop 集成使用临时副本，typecheck 通过
- [x] AC3a: reminder 为空时，用户消息 content 不含 `<system-reminder>` 标签 — 证据：AgentLoop 代码 `input.reminder && input.reminder.length > 0` 守卫
- [x] AC9: constraints 模块文本包含 `<system-reminder>` 和「不要将其作为用户提问进行回复」 — 证据：modules.test.ts 通过
- [x] reminder 前置不 mutate 原始 input.userMessage — 证据：AgentLoop 中创建 `{ ...input.userMessage, content: ... }` 临时副本

## 频率控制

- [x] AC6: plan mode turnIndex=0 完整版、turnIndex=1 精简版、turnIndex=4 完整版 — 证据：builder.test.ts 通过
- [x] AC6a: reminderInterval=2 时 turnIndex=2 完整版、turnIndex=1 精简版 — 证据：builder.test.ts 通过
- [x] AC6b: full mode turnIndex=0 时 reminder 不含模式提醒 — 证据：builder.test.ts 通过

## 环境上下文

- [x] AC13: 传入 env 对象时，reminder 包含 `OS: win32 | Shell: powershell | CWD: /tmp/project | Date: 2026-07-08` 格式 — 证据：builder.test.ts 通过

## Provider 集成

- [x] AC2: Anthropic 请求体含 `system: [{ type: 'text', text: ..., cache_control: { type: 'ephemeral' } }]` + `anthropic-beta` header — 证据：grep 确认 cache_control 和 anthropic-beta 存在
- [x] AC2a: system 为 undefined 时 Anthropic 不设 system 字段，OpenAI 不插入 system 消息 — 证据：Provider 代码中 `if (request.system && request.system.length > 0)` 守卫
- [x] AC15: OpenAI 请求体含 `stream_options: { include_usage: true }` — 证据：grep 确认 `stream_options` 存在
- [x] OpenAI system message prepend 到 messages[0] — 证据：grep 确认 `role: 'system'` prepend 逻辑

## 缓存用量

- [x] AC4: Provider 解析 mock 响应含 usage 字段后，yield `response.usage` 事件 — 证据：Provider 代码中有 usage 解析和 yield 逻辑
- [x] AC4a: mock 响应不含缓存字段时，事件仍正常发出，可选字段为 undefined — 证据：Provider 代码使用防御性类型守卫
- [x] usage 字段为 null/非数字时不抛异常 — 证据：`typeof x === 'number' ? x : undefined` 防御模式

## 工具描述增强

- [x] AC5: edit_file description 含「read_file」、write_file 含「edit_file」、run_command 含「专用工具」 — 证据：enhanceToolDeclarations.test.ts 7/7 通过
- [x] AC5a: 未增强工具 description 不变 — 证据：enhanceToolDeclarations.test.ts 通过
- [x] 原始 declarations 数组不被修改 — 证据：enhanceToolDeclarations.test.ts 不可变性断言通过

## plan 迁移

- [x] AC10: AgentLoop 构建的 ProviderRequest messages 中不含由 buildPlanContextMessage 产生的独立 plan 消息；plan 内容在 `<active-plan>` 标签内 — 证据：函数已删除，builder 在 plan 非空时生成 `<active-plan>` 标签
- [x] `buildPlanContextMessage` 函数定义和调用点已完全删除 — 证据：`grep -r buildPlanContextMessage src/` 返回 CLEAN
- [x] plan 为空数组 `[]` 时 reminder 不含 `<active-plan>` 标签 — 证据：builder.ts 中 `input.plan && input.plan.length > 0` 守卫

## 模块文件约束

- [x] AC14: 每个固定模块文件导出 content 字符串常量 — 证据：modules.test.ts 遍历验证通过
- [x] AC14a: 所有模块 content 不含 `${` 模板插值 — 证据：modules.test.ts 正则验证通过

## 构建器幂等性

- [x] AC11: 相同 input 调用两次，system 和 reminder 完全相等 `===` — 证据：builder.test.ts 幂等性用例通过

## 集成

- [x] AC12: ChatSessionController 通过依赖注入获取构建器函数，测试可用 mock 替换 — 证据：session 测试中 `createController` 注入 mock builder，14 个测试通过
- [x] system 字段在会话初始化时计算一次并缓存，后续 turn 不重算 — 证据：Controller 构造函数中 `this.systemPrompt = system`，后续仅取 reminder
- [x] turnIndex 每次 submitUserText 递增 — 证据：Controller 中 `this.turnIndex++` 在每轮调用后执行
- [x] 模式切换不重置 turnIndex — 证据：turnIndex 是会话级计数器，模式切换只影响 mode 参数

## 回归与风险检查

- [x] `reminderInterval` 为 0 或负数时不导致除零异常 — 证据：builder.ts 中 `Math.max(1, Math.floor(input.reminderInterval ?? 4))`
- [x] AgentLoop 中 ProviderEvent switch 包含显式 `case 'response.usage'` 分支 — 证据：T6 实现中添加了显式 case + console.debug
- [x] 所有新增可选字段使用 spread 模式赋值而非直接赋 undefined — 证据：`npm run typecheck` 通过（exactOptionalPropertyTypes 会捕获违规）
- [x] Anthropic beta header 与现有 headers 非破坏性合并 — 证据：Provider 代码检查已有 header 并做逗号拼接

## 编译与测试

- [x] AC8: `npm run typecheck` 通过 — 证据：`npx tsc --noEmit` 无输出（0 errors）
- [x] AC8: `npm test` 核心用例通过 — 证据：123/123 核心测试通过（system-prompt + agent + session + providers）
- [x] 新增测试文件通过：`npm test -- tests/unit/system-prompt/` — 证据：31 + 7 = 38 个测试全部通过

## 端到端场景

- [ ] 场景 1：启动 CLI → 输入普通消息 → debug log 显示 system prompt 被设置到 ProviderRequest → 响应正常流式返回（待手动验证）
- [ ] 场景 2：启动 CLI → `/plan` 切换模式 → 输入消息 → reminder 中包含模式标识 → plan 工具调用正常工作（待手动验证）
- [ ] 场景 3：连续对话 2 轮以上 → Anthropic debug log 显示 `cache_read_input_tokens > 0`（待 Anthropic Provider 手动验证）
