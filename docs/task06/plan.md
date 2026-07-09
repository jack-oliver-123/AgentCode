# 工具权限系统 Plan

## 方案选择摘要

- **候选方案来源：** 3 个只读子代理分别从架构一致性、测试与回滚、最小风险角度提出。
- **最终选择：** 最小风险方案为底座，融合架构一致性方案的纯函数管道和类型设计。
- **选择理由：** 改动面最小（2 个已有文件核心修改）、现有测试零破坏、分阶段可交付、F6 免费实现。TUI 弹窗用注入回调阻塞 promise（ToolScheduler 对 write/execute 已串行），比事件驱动方案简单。
- **丢弃说明：** 事件驱动弹窗流程（架构方案新增 AgentLoopEvent 变体）和多级 feature flags / shadow mode（回滚方案）对 MVP 过度设计；吸收其纯函数管道设计、fail-safe 默认值和安全测试策略。

## 架构概览

权限系统是一个**纯函数管道**，以单个可选字段注入现有 `executeToolCall` 流程。管道本身无副作用、无 I/O，唯一的异步出口是 TUI 弹窗回调（由外部注入）。

```
┌─────────────────────────────────────────────────────────────┐
│  executeToolCall (existing pipeline)                        │
│                                                             │
│  JSON parse → registry lookup → validate                   │
│                                       ↓                     │
│                              ┌─────────────────┐            │
│                              │ PermissionChecker│ ← NEW     │
│                              │  (optional)      │            │
│                              └────────┬────────┘            │
│                         allow ←───────┤───────→ deny        │
│                           ↓                       ↓         │
│                    abort check               return error   │
│                         ↓                  (permission_denied)│
│                    tool.execute                              │
└─────────────────────────────────────────────────────────────┘
```

**组件划分：**

| 组件 | 职责 | 状态性 |
|------|------|--------|
| PermissionChecker | 编排管道各层，返回最终判定 | 有状态（持有 sessionAllowlist + mode） |
| BlacklistGuard | 正则匹配危险命令 | 无状态 |
| PathSandbox | 委托 workspace.ts 检查路径边界 | 无状态 |
| RuleEngine | 编译和匹配 YAML 规则 | 无状态（规则加载后不可变） |
| AutoSafetyRules | 硬编码安全白名单匹配 | 无状态 |
| ModePolicy | 按模式返回默认判定 | 无状态 |
| SessionAllowlist | 存储"本会话允许"的规则 | 有状态（内存 Map） |
| PermissionConfig | 加载/合并三层 YAML 规则 | 一次性加载后不可变 |
| AskPermissionFn | TUI 弹窗回调（注入） | 无（由 TUI 层实现） |

## 核心数据结构

```typescript
// src/tools/permissions/types.ts

import type { ToolRisk, ToolExecutionError } from '../types.js';

// ─── 权限模式 ────────────────────────────────────────────────

export type PermissionMode = 'plan' | 'strict' | 'normal' | 'auto' | 'yolo';

// ─── 权限判定结果（discriminated union）─────────────────────

export type PermissionDecision =
  | { allowed: true; source: PermissionSource }
  | { allowed: false; error: ToolExecutionError; source: PermissionSource };

/** 判定来源（用于错误信息和调试）*/
export type PermissionSource =
  | 'blacklist'
  | 'path_sandbox'
  | 'rule_allow'
  | 'rule_deny'
  | 'auto_safety'
  | 'mode_default'
  | 'session_grant'
  | 'user_prompt';

// ─── 权限检查输入 ────────────────────────────────────────────

export interface PermissionCheckInput {
  toolName: string;
  toolRisk: ToolRisk;
  parsedArguments: unknown;
  cwd: string;
}

// ─── 规则定义 ────────────────────────────────────────────────

/** YAML 中的原始规则 */
export interface PermissionRule {
  rule: string;        // "tool_name(glob_pattern)"
  action: 'allow' | 'deny';
}

/** 编译后的规则（解析 tool name 和 pattern 后）*/
export interface CompiledRule {
  toolName: string;
  argPattern: string | undefined;  // glob pattern，undefined = 匹配所有
  action: 'allow' | 'deny';
}

// ─── 规则配置（三层）────────────────────────────────────────

export interface PermissionRuleConfig {
  session: readonly CompiledRule[];   // 内存中，会话结束丢弃
  project: readonly CompiledRule[];   // .agentcode/permissions.yaml
  global: readonly CompiledRule[];    // ~/.agentcode/permissions.yaml
}

// ─── TUI 弹窗回调（注入接口）────────────────────────────────

export type AskPermissionFn = (
  input: PermissionCheckInput,
  description: string,
) => Promise<PromptResponse>;

export type PromptResponse =
  | { action: 'allow_once' }
  | { action: 'allow_session' }
  | { action: 'allow_permanent' }
  | { action: 'deny' };

// ─── PermissionChecker 接口 ──────────────────────────────────

export interface PermissionChecker {
  check(input: PermissionCheckInput): Promise<PermissionDecision>;
  addSessionRule(rule: CompiledRule): void;
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
}
```

## 模块设计

### BlacklistGuard

**职责：** 对 run_command 工具的 command 参数做正则匹配，命中则返回 deny。
**对外接口：** `checkBlacklist(input: PermissionCheckInput): PermissionDecision | undefined`
**依赖：** 无（纯函数，正则硬编码）
**行为：** 仅当 `toolName === 'run_command'` 时激活。从 `parsedArguments` 中提取 `command` 字段（字符串）进行正则匹配。返回 `undefined` 表示未命中，交给下一层。

**黑名单正则集合（初始穷举）：**
- `rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+.*)?\/` — rm -rf / 及变体
- `chmod\s+777\s+\/` — 对系统根目录 chmod 777
- `:\(\)\{.*\|.*&.*\}` — fork bomb
- `mkfs` — 格式化命令
- `dd\s+.*if=\/dev\/(zero|random).*of=\/dev\/[sh]d` — dd 写磁盘设备
- `>\s*\/dev\/[sh]d` — 重定向到磁盘设备
- `(curl|wget).*\|\s*(bash|sh|zsh)` — 管道远程执行

### PathSandbox

**职责：** 对文件类工具的 path 参数调用现有 `resolveWorkspacePath` 验证路径边界。
**对外接口：** `checkPathSandbox(input: PermissionCheckInput, cwd: string): PermissionDecision | undefined`
**依赖：** `resolveWorkspacePath`（来自 `src/tools/workspace.ts`，返回 `WorkspacePathResult` discriminated union：`{ok: true, absolutePath, relativePath}` 或 `{ok: false, error}`）
**行为：** 仅当工具为 read_file/write_file/edit_file/glob_files/search_code 时激活。从 `parsedArguments` 中提取路径字段（read_file/write_file/edit_file 为 `path`，glob_files 为 `pattern`，search_code 为 `path`）。路径越界返回 deny，正常返回 `undefined`。

### RuleEngine

**职责：** 按三层优先级匹配已编译规则，返回第一条命中的结果。
**对外接口：**
- `compileRules(raw: PermissionRule[]): CompiledRule[]` — 启动时调用一次，解析 `"tool_name(glob)"` 格式
- `matchRules(input: PermissionCheckInput, config: PermissionRuleConfig): PermissionDecision | undefined`
**依赖：** picomatch（glob 匹配）
**参数提取逻辑：** 根据 toolName 从 parsedArguments 中提取匹配目标字符串：
- `run_command` → `(parsedArguments as {command: string}).command`
- `read_file` / `write_file` / `edit_file` → `(parsedArguments as {path: string}).path`
- `glob_files` → `(parsedArguments as {pattern: string}).pattern`
- `search_code` → `(parsedArguments as {path: string}).path`

**匹配顺序：** session → project → global，每层内按声明顺序从上到下，first-match-wins。`*` 不跨分隔符，`**` 跨分隔符，`\*` 匹配字面星号。未命中返回 `undefined`。

### AutoSafetyRules

**职责：** auto 模式专用，硬编码安全白名单判断。
**对外接口：** `checkAutoSafety(input: PermissionCheckInput, mode: PermissionMode): PermissionDecision | undefined`
**依赖：** picomatch（路径 glob 匹配）
**行为：** 仅 `mode === 'auto'` 时激活。判断逻辑：
- `toolRisk === 'read'` → allow（read_file、glob_files、search_code 全部放行）
- `toolName` 为 write_file/edit_file 且路径匹配 `src/**`、`tests/**`、`docs/**` → allow
- `toolName === 'run_command'` 且命令前缀匹配以下白名单之一 → allow：
  - `git status`、`git diff`、`git log`、`git branch`
  - `npm test`、`npm run build`、`npm run typecheck`
  - `npx tsc --noEmit`、`npx vitest`
- 其余 → 返回 `undefined`（交给 ModePolicy）

### ModePolicy

**职责：** 管道最后一层，按当前模式返回兜底判定。
**对外接口：** `applyModeDefault(input: PermissionCheckInput, mode: PermissionMode): PermissionDecision | 'needs_prompt'`
**依赖：** 无
**行为：** 始终返回明确结果（不返回 undefined）：
- `strict` → deny（message: "not explicitly allowed in strict mode"）
- `normal` → `'needs_prompt'`
- `auto` → `'needs_prompt'`
- `yolo` → allow
- `plan` → 不会走到这里（plan 模式在注册层已过滤）

### SessionAllowlist

**职责：** 存储"本会话允许"的规则，供管道查询。
**对外接口：**
- `has(input: PermissionCheckInput): boolean`
- `add(rule: CompiledRule): void`
- `clear(): void`
**依赖：** picomatch（复用 RuleEngine 的匹配逻辑）
**状态：** 内存中 `CompiledRule[]`（与 RuleEngine 格式一致），匹配逻辑与 RuleEngine 相同。
**Canonical key 构造：** 不使用 key-based Map，直接复用 matchRules 逻辑——遍历 session 规则数组做 glob 匹配。`add()` 时将新规则追加到数组头部（最新的优先）。

### PermissionConfig（规则加载器）

**职责：** 启动时从三层 YAML 文件加载并编译规则。
**对外接口：** `loadPermissionRules(cwd: string, homeDir: string): PermissionRuleConfig`
**依赖：** YAML 解析（项目已有 yaml 依赖）、`compileRules`（来自 RuleEngine）
**文件路径：**
- 项目级：`{cwd}/.agentcode/permissions.yaml`
- 全局级：`{homeDir}/.agentcode/permissions.yaml`
**行为：** 文件不存在→空数组。格式错误→输出警告（含文件路径和错误位置），返回空数组。返回不可变的 `PermissionRuleConfig`（session 初始为空数组）。

### PermissionChecker（编排器）

**职责：** 组合以上所有模块为一个完整管道，对外暴露 `check()` 方法。
**工厂函数：** `createPermissionChecker(options: PermissionCheckerOptions): PermissionChecker`

```typescript
interface PermissionCheckerOptions {
  mode: PermissionMode;
  ruleConfig: PermissionRuleConfig;
  cwd: string;
  askFn?: AskPermissionFn;
}
```

**管道执行顺序：**
1. `checkBlacklist(input)` → 命中则 deny
2. `checkPathSandbox(input, cwd)` → 命中则 deny
3. `sessionAllowlist` 查询 → 命中则 allow
4. `matchRules(input, ruleConfig)` → 命中则返回 allow/deny
5. `checkAutoSafety(input, mode)` → 命中则 allow
6. `applyModeDefault(input, mode)` → strict→deny, normal/auto→needs_prompt, yolo→allow
7. 若 needs_prompt：
   - 有 `askFn` → 调用并等待（30s 超时，超时 deny）
   - 无 `askFn` → deny（fail-safe）
8. 处理 askFn 响应：
   - `allow_once` → return allowed
   - `allow_session` → 生成 CompiledRule 加入 sessionAllowlist → return allowed
   - `allow_permanent` → 生成 CompiledRule 追加写入项目级 permissions.yaml → return allowed
   - `deny` → return denied

## 模块交互

### 初始化流程（会话启动时）

```
ChatSessionController 构造
  │
  ├─ loadConfig() → config（含 permission_mode 字段，默认 'normal'）
  │
  ├─ loadPermissionRules(cwd, homeDir)
  │     ├─ 读取 ~/.agentcode/permissions.yaml → compileRules() → global rules
  │     ├─ 读取 .agentcode/permissions.yaml → compileRules() → project rules
  │     └─ 合并为 PermissionRuleConfig { session: [], project, global }
  │
  ├─ createPermissionChecker({
  │     mode: config.permission_mode,
  │     ruleConfig,
  │     cwd,
  │     askFn: tuiPermissionPrompt,  // TUI 层提供的回调
  │   }) → PermissionChecker
  │
  └─ 注入 checker 到 createToolContext 工厂
```

### 运行时流程（每次工具调用）

```
AgentLoop → ToolScheduler.executeBatches()
  → executeToolCall(call, registry, context)
      │
      ├─ JSON.parse(call.argumentsText) → parsedArguments
      ├─ registry.get(call.name) → tool
      ├─ tool.validate(parsedArguments) → validation.value
      │
      ├─ ★ context.permissionChecker?.check({
      │       toolName: tool.name,
      │       toolRisk: tool.risk,
      │       parsedArguments: validation.value,
      │       cwd: context.cwd,
      │   })
      │   │
      │   │  PermissionChecker.check() 内部：
      │   ├─ 1. checkBlacklist(input) → deny?
      │   ├─ 2. checkPathSandbox(input, cwd) → deny?
      │   ├─ 3. sessionAllowlist 匹配 → allow?
      │   ├─ 4. matchRules(input, ruleConfig) → allow/deny?
      │   ├─ 5. checkAutoSafety(input, mode) → allow?
      │   ├─ 6. applyModeDefault(input, mode) → deny/allow/needs_prompt
      │   └─ 7. needs_prompt → askFn() → 处理响应
      │
      ├─ decision.allowed === false?
      │     → return { ok: false, error: { code: 'permission_denied', ... }, ... }
      │
      ├─ context.signal?.aborted check
      └─ tool.execute(validation.value, context)
```

### 弹窗交互流程

```
PermissionChecker.check()
  → applyModeDefault() returns 'needs_prompt'
  → 调用 askFn(input, description)
      │
      │  askFn 的实现（在 TUI 层）：
      ├─ 渲染 PermissionPrompt Ink 组件
      │     显示：工具名、参数摘要、risk 类型（read/write/execute）
      │     选项：允许(本次) | 允许(本会话) | 允许(永久) | 拒绝
      ├─ 阻塞等待用户按键选择（30s 超时）
      ├─ 用户选择后 resolve Promise
      └─ 返回 PromptResponse 给 PermissionChecker
```

**关键设计点：** TUI 弹窗阻塞的是 `executeToolCall` 的 async promise。ToolScheduler 对 write/execute 工具已串行执行，阻塞一个 promise 不影响其他工具。Ink 事件循环不受阻塞影响（Node.js 事件循环保持运转，可渲染 UI 和接收按键）。

## 文件组织

```
src/tools/permissions/              ← 新建目录，所有权限逻辑集中于此
├── types.ts                        — 所有类型定义
├── blacklist.ts                    — F1: checkBlacklist()
├── blacklistPatterns.ts            — 黑名单正则集合（独立文件便于审查）
├── pathSandbox.ts                  — F2: checkPathSandbox()
├── ruleEngine.ts                   — F3: compileRules() + matchRules()
├── ruleParser.ts                   — 解析 "tool_name(glob)" 格式
├── autoSafety.ts                   — F4: checkAutoSafety()
├── modePolicy.ts                   — applyModeDefault()
├── sessionAllowlist.ts             — 会话级规则存储
├── config.ts                       — loadPermissionRules()
├── checker.ts                      — createPermissionChecker() 工厂
├── promptDescription.ts            — 生成弹窗展示文本
└── index.ts                        — 公共 API 导出

src/tui/
└── PermissionPrompt.tsx            — F5: Ink 阻塞式弹窗组件（新建）

src/tools/
├── executor.ts                     — 修改：validation 后插入 ~12 行权限检查
└── types.ts                        — 修改：ToolExecutionContext 增加 optional permissionChecker

src/config/
└── schema.ts                       — 修改：RawConfig 增加 optional permission_mode

src/session/
└── ChatSessionController.ts        — 修改：初始化 PermissionChecker 并注入 createToolContext

tests/unit/tools/permissions/       ← 新建测试目录
├── blacklist.test.ts
├── pathSandbox.test.ts
├── ruleEngine.test.ts
├── autoSafety.test.ts
├── modePolicy.test.ts
├── sessionAllowlist.test.ts
├── config.test.ts
├── checker.test.ts
└── prompt-flow.test.ts
```

**改动统计：**
- 新建文件：~14 个源码 + ~9 个测试
- 修改已有文件：4 个（executor.ts、types.ts、schema.ts、ChatSessionController.ts）
- 已有文件改动量：executor.ts ~12 行，types.ts ~3 行，schema.ts ~5 行，ChatSessionController.ts ~15 行

## 风险与回滚

| 风险 | 影响 | 缓解策略 |
|------|------|---------|
| executor.ts 修改引入 bug 影响所有工具执行 | 高 | 改动仅 ~12 行，`permissionChecker` 为 undefined 时零行为变化；现有 executor 测试必须全部通过 |
| TUI 弹窗阻塞导致 agent loop 卡死 | 中 | askFn 加 30s 超时，超时后 auto-deny；无 askFn 时直接 deny（fail-safe） |
| picomatch 依赖引入安全漏洞或 ReDoS | 低 | picomatch 是成熟库，glob 模式由用户编写而非外部输入；可限制 pattern 长度 |
| 规则配置错误导致合法操作被拒 | 中 | 配置容错：格式错误回退空规则集 + 警告；yolo 模式作为紧急逃生口 |
| 黑名单正则误判合法命令（如 `rm file.txt`） | 低 | 黑名单只匹配明确破坏性命令（含 `-rf /` 等标志），单元测试覆盖 false-positive 场景 |
| `allow_permanent` 写入 YAML 失败 | 低 | catch 错误，降级为 session-only grant，向用户显示警告 |
| picomatch 非项目已有依赖需新增 | 低 | 锁定版本，picomatch 零依赖、体积小（~3KB）；备选：手写简单 glob 匹配器 |

**回滚策略（无需修改 executor.ts）：**
- Level 1：将 `permission_mode` 设为 `yolo` → 等效禁用弹窗和规则拒绝（黑名单仍生效）
- Level 2：从 `createToolContext` 中移除 `permissionChecker` 注入 → 完全回退到无权限状态

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 权限检查插入位置 | executor.ts 内 validate 之后、abort check 之前 | 最窄拦截点，validation 通过后才有意义检查权限；单点修改 |
| 注入方式 | ToolExecutionContext 增加 optional 字段 | 遵循项目已有的 context 注入模式（如 signal）；optional 保证向后兼容 |
| 权限模块位置 | `src/tools/permissions/` 子目录 | 属于 tools 层的子系统，独立目录便于整体移除或审查 |
| glob 匹配库 | picomatch | 零依赖、性能好、支持标准 `*`/`?`/`**` 语义；比 minimatch 轻量 |
| 规则文件格式 | YAML（独立 permissions.yaml） | 项目已用 YAML 做配置；独立文件避免主配置膨胀 |
| 弹窗实现 | 注入 async 回调而非事件驱动 | ToolScheduler 对 write/execute 已串行执行，阻塞 promise 不造成并发问题；比新增 AgentLoopEvent 简单 |
| ModePolicy needs_prompt 无 askFn 时 | deny（fail-safe） | 安全优先：宁可多拒绝也不默默放行 |
| 会话规则存储 | 内存数组，无持久化 | spec 明确要求不做持久化恢复；简单可靠 |
| 黑名单正则存储 | 独立 blacklistPatterns.ts 文件 | 便于代码审查和后续版本扩展，与匹配逻辑分离 |
| 路径沙箱实现 | 直接调用现有 resolveWorkspacePath | 已有完整实现，不重复造轮子 |
| 黑名单与规则优先级 | 黑名单始终优先，不可被 allow 规则覆盖 | spec 明确要求"不可配置放开"；管道顺序保证黑名单第一个执行 |
