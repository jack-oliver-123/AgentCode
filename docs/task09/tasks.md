# 会话记忆与指令系统 Tasks

## 绑定输入

- spec.md: 4adea65de6e1d10e035d8cec7e0e262f5d31fc19
- plan.md: 28a7730e0991ca04a7293bd95a35c57e4159f2f9

## 文件清单

| 操作 | 路径 | 任务 |
|------|------|------|
| 修改 | `src/system-prompt/registry.ts` | T1 |
| 新建 | `src/system-prompt/loadProjectRules.ts` | T2 |
| 新建 | `tests/unit/system-prompt/loadProjectRules.test.ts` | T2 |
| 新建 | `src/system-prompt/loadMemoryIndex.ts` | T3 |
| 新建 | `tests/unit/system-prompt/loadMemoryIndex.test.ts` | T3 |
| 修改 | `src/system-prompt/loadDynamicModules.ts` | T4 |
| 修改 | `src/system-prompt/index.ts` | T4 |
| 新建 | `src/session/SessionArchive.ts` | T5 |
| 新建 | `tests/unit/session/SessionArchive.test.ts` | T5 |
| 新建 | `src/session/SessionRestore.ts` | T6 |
| 新建 | `src/session/SessionCleaner.ts` | T6 |
| 新建 | `tests/unit/session/SessionRestore.test.ts` | T6 |
| 新建 | `tests/unit/session/SessionCleaner.test.ts` | T6 |
| 新建 | `src/session/ResumeSelector.ts` | T7 |
| 新建 | `src/notes/AutoNoteWriter.ts` | T8 |
| 新建 | `tests/unit/notes/AutoNoteWriter.test.ts` | T8 |
| 修改 | `src/session/ChatSessionController.ts` | T9 |
| 修改 | `src/app/bootstrapApp.tsx` | T10 |
| 修改 | `src/cli/main.ts` | T10 |
| 新建 | `tests/integration/bootstrapApp-resume.test.ts` | T10 |

## T1: 新增 project-rules slot

**目标：** `src/system-prompt/registry.ts` 中新增 `project-rules` slot（order=660），位于 `project-context`（650）和 `custom-instructions`（700）之间；所有依赖 `defaultRegistry` 的 mock 编译通过。

**文件：** `src/system-prompt/registry.ts`

**依赖：** 无

**测试先行：**

1. 运行 `npm run typecheck`，记录当前通过状态作为基线。
2. 在 `registry.ts` 的 `defaultRegistry` 数组中追加 `project-rules` 条目，但故意将 order 设为错误值（如 999）。
3. 运行 `npm test -- tests/unit/system-prompt/`，预期现有测试因 slot 顺序断言失败（若有）或通过（若无相关断言）。
4. 将 order 修正为 660，重跑测试，预期通过。
5. 运行 `npm run typecheck`，预期若有 mock 缺失字段则报错；按错误列表逐一补全 mock 中的 `project-rules` 条目。

**回归验证：** 运行 `npm test && npm run typecheck`，预期全量通过。

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T2: loadProjectRules + resolveIncludes（@include 安全展开）

**目标：** 新建 `loadProjectRules(cwd, homeDir)` 函数，三层加载拼接 `AGENTCODE.md`，支持 `@include` 展开，路径安全检查在 `path.resolve()` 后比较前缀；通过 AC1、AC2、AC8 对应单元测试。

**文件：** `src/system-prompt/loadProjectRules.ts`，`tests/unit/system-prompt/loadProjectRules.test.ts`

**依赖：** 无（可与 T3 并行）

**测试先行：**

1. 在测试文件中用 `tmp` 目录构造 fixture：项目根 `AGENTCODE.md` 含标记文本 A，`.agentcode/AGENTCODE.md` 含标记文本 B，全局 `~/.agentcode/AGENTCODE.md` 含标记文本 C。
2. 运行 `npm test -- tests/unit/system-prompt/loadProjectRules.test.ts`，预期因 `loadProjectRules.ts` 不存在而失败。
3. 实现 `loadProjectRules`，使 B 出现在 A 之前（`.agentcode/AGENTCODE.md` 最先注入）。
4. 测试 `@include utils/shared.md`（在 projectRoot 内）：内容被展开。
5. 测试 `@include ../../../etc/passwd`（跳出 projectRoot）：函数内部抛出 Error，调用方捕获后内容不含目标文件内容，其余内容正常加载；warn 日志有记录。
6. 测试全局文件中 `@include` 目标在 `~/.agentcode/` 外：同样记录 warn 并跳过。
7. 测试 A→B→A 环路：不死循环，不崩溃。
8. 测试 5 层嵌套（A→B→C→D→E→F）：第 5 层内容不出现在结果中。
9. 重跑测试，预期全部通过。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 高风险（路径安全），3 个只读 reviewer。

---

## T3: loadMemoryIndex

**目标：** 新建 `loadMemoryIndex(cwd, homeDir)` 函数，读取用户级和项目级 `MEMORY.md` 索引，返回合并文本；读取失败静默返回空字符串。

**文件：** `src/system-prompt/loadMemoryIndex.ts`，`tests/unit/system-prompt/loadMemoryIndex.test.ts`

**依赖：** 无（可与 T2 并行）

**测试先行：**

1. 构造 fixture：`~/.agentcode/memory/MEMORY.md` 含用户级条目，`<project>/.agentcode/memory/MEMORY.md` 含项目级条目。
2. 运行 `npm test -- tests/unit/system-prompt/loadMemoryIndex.test.ts`，预期因文件不存在而失败。
3. 实现函数，断言合并文本包含两级内容。
4. 测试文件不存在时返回空字符串，不抛出。
5. 重跑测试，预期通过。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T4: loadDynamicModules 集成扩展

**目标：** `loadDynamicModules` 签名扩展为 `(cwd, homeDir)`，集成 `loadProjectRules` 和 `loadMemoryIndex`；memory slot 改为注入两级 MEMORY.md 索引（旧 `.agentcode/memory.md` 若存在则追加，向后兼容）；`src/system-prompt/index.ts` 导出新函数。

**文件：** `src/system-prompt/loadDynamicModules.ts`，`src/system-prompt/index.ts`

**依赖：** T1、T2、T3

**测试先行：**

1. 在现有 `loadDynamicModules.test.ts`（若存在）或新建测试中，断言传入 `homeDir` 参数后 `project-rules` slot 内容包含 `AGENTCODE.md` 标记文本。
2. 运行测试，预期因签名不匹配而失败。
3. 扩展 `loadDynamicModules` 签名，集成新函数调用。
4. 验证旧 `memory.md` 兼容：放置 `.agentcode/memory.md`，断言 memory slot 内容仍包含其内容。
5. 重跑测试，预期通过。
6. 运行 `npm run typecheck`，修复 `bootstrapApp.tsx` 中调用 `loadDynamicModules` 的传参（补充 `homeDir` 参数）。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 高风险（核心 system prompt 路径），3 个只读 reviewer。

---

## T5: SessionArchive（会话存档写入）

**目标：** 新建 `SessionArchive` 类，生成会话 ID（`YYYYMMDD-HHMMSS-xxxx`），追加写入 JSONL，每行含 `_ts`；user/assistant 文本消息含 `_ui`；目录以 `0o700` 创建，文件以 `0o600` 写入；通过 AC3 对应单元测试。

**文件：** `src/session/SessionArchive.ts`，`tests/unit/session/SessionArchive.test.ts`

**依赖：** 无（可与 T2/T3 并行）

**测试先行：**

1. 构造 fixture：调用 `archive.append([userMsg, toolCallMsg, toolResultMsg])`。
2. 运行测试，预期因文件不存在而失败。
3. 实现 `SessionArchive`，验证：每行为合法 JSON；user 行含 `_ts`、`_ui.author='user'`；assistant 文本行含 `_ui.author='agent'`；工具调用行含 `toolCalls`，无 `_ui`；工具结果行含 `toolCallId`、`toolName`、`isError`，无 `_ui`；追加写入不覆盖旧行。
4. 验证目录权限为 `0o700`，文件权限为 `0o600`（跳过 Windows 平台 chmod 测试，仅 Linux/macOS 断言）。
5. 重跑测试，预期通过。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T6: SessionRestore + SessionCleaner（会话恢复与清理）

**目标：** 新建 `SessionRestore`（扫描会话列表、解析 JSONL 含异常处理）和 `SessionCleaner`（惰性清理）；通过 AC4、AC5 对应单元测试。

**文件：** `src/session/SessionRestore.ts`，`src/session/SessionCleaner.ts`，`tests/unit/session/SessionRestore.test.ts`，`tests/unit/session/SessionCleaner.test.ts`

**依赖：** T5（复用 JSONL schema 知识，但不直接依赖 SessionArchive 实现）

**测试先行（SessionRestore）：**

1. 构造含坏行、孤立工具调用、24h 时间跨度的 JSONL fixture。
2. 运行测试，预期失败。
3. 实现 `loadSession`：坏行跳过；孤立 `toolCalls` 消息后截断；`_ts` 差 > 86400000ms 处插入合成 `role: user` 提醒消息；返回 `{ providerContext, messages }`。
4. 断言合成消息内容格式为 `[距上次对话已超过 N 小时，本段对话发生于 YYYY-MM-DD HH:MM]`。
5. 重跑测试，预期通过。

**测试先行（SessionCleaner）：**

1. 注入 `last_cleanup` 为 8 天前 ISO 8601 时间戳，`sessions/` 下放置 mtime 为 31 天前的文件。
2. 调用 `maybeClean(cwd)`，断言返回 Promise（非 void）、调用方不 await；清理完成后文件被删除。
3. 断言 `last_cleanup` 被更新为当前时间附近的 ISO 8601 字符串。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T7: ResumeSelector（readline 交互式会话选择）

**目标：** 新建 `ResumeSelector`，在 Ink TUI 挂载前用 Node.js readline 列出最近 10 条会话供用户选择，非 TTY 环境返回 null；readline 实例在返回前关闭，不影响后续 Ink 终端状态。

**文件：** `src/session/ResumeSelector.ts`

**依赖：** T6

**测试先行：**

1. 用 mock stdin 模拟用户选择第 2 条会话，断言 `pickSession(cwd)` 返回对应的 `RestoredSession`。
2. 运行测试，预期失败。
3. 实现 `pickSession`：在非 TTY 时（`!process.stdin.isTTY`）直接返回 null；否则展示会话列表，等待用户输入序号，关闭 rl 实例后返回。
4. 断言 `sessions/` 为空时返回 null（无报错）。
5. 重跑测试，预期通过。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 低风险，1 个只读 reviewer。

---

## T8: AutoNoteWriter（触发判断 + LLM + 原子写）

**目标：** 新建 `AutoNoteWriter`，实现关键词/token 触发判断、LLM 调用、JSON 解析、原子写笔记文件、重建 MEMORY.md 索引（含最多 3 次裁剪循环）；通过 AC6 对应单元测试（两条触发路径均覆盖）。

**文件：** `src/notes/AutoNoteWriter.ts`，`tests/unit/notes/AutoNoteWriter.test.ts`

**依赖：** T3（loadMemoryIndex 接口）

**测试先行：**

1. 注入 LLM mock，模拟返回含 `add` 操作的 JSON 数组。
2. 场景 A：用户消息含"以后不要用 any 类型"，`completionTokens=0`，触发关键词路径，预期创建笔记文件且 frontmatter `metadata.type: feedback`。
3. 场景 B：用户消息无关键词，`completionTokens=300`，回复含 ` ``` ` 代码围栏，预期同样触发更新。
4. 场景 C：用户消息无关键词，`completionTokens=300`，回复无代码围栏，预期**不触发**。
5. 运行测试，预期因文件不存在而失败。
6. 实现 `AutoNoteWriter`，通过所有场景。
7. 验证索引行数不超过 200 行；LLM JSON 解析失败时静默跳过，写 warn 日志。
8. 验证 `memory/` 目录以 `0o700` 创建，笔记文件以 `0o600` 写入。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 高风险（LLM 调用 + 文件系统写入），3 个只读 reviewer。

---

## T9: ChatSessionController 修改

**目标：** `ChatSessionController` 支持 `initialProviderContext`/`initialMessages`；构造时调用 `contextManager.onMessagesAppended(initialProviderContext)`；新增 `_turnCompletionTokens` per-turn 累积字段；`completeTurn` 改为 async（await `SessionArchive.append`，fire-and-forget `AutoNoteWriter.maybeUpdate`）；`applyAgentLoopEvent` 同步传播 async 调用链；所有现有测试通过。

**文件：** `src/session/ChatSessionController.ts`

**依赖：** T5、T8

**测试先行：**

1. 在现有 `ChatSessionController` 测试中新增：构造时传入 `initialProviderContext`（含 2 条消息），断言 `getState()` 后的首轮 LLM 调用携带这 2 条历史消息（通过 mock provider 验证）。
2. 运行测试，预期因 `initialProviderContext` 字段不存在而编译失败。
3. 实现字段接入与构造器初始化（`onMessagesAppended`）；新增 `_turnCompletionTokens`；在 `token.usage` 分支 `+= completionTokens ?? 0`；修改 `completeTurn` 为 async。
4. 验证 `applyAgentLoopEvent` 的 async 传播不破坏现有 `for await` 循环（`submitUserText`）。
5. 运行 `npm run typecheck`，修复类型错误。
6. 运行全量测试，预期通过。

**回归验证：** 运行 `npm test && npm run typecheck`，预期通过。

**任务后审查：** 高风险（核心 session 路径），3 个只读 reviewer。

---

## T10: bootstrapApp + main.ts 接入（--resume 编排）

**目标：** `main.ts` 解析 `--resume` argv，直接调用 `bootstrapApp({ resumeMode: true })`；`bootstrapApp` 编排所有新模块，处理 resumeMode 时调用 `ResumeSelector`，将结果传入 `ChatSessionController`；通过 AC7 集成测试。

**文件：** `src/app/bootstrapApp.tsx`，`src/cli/main.ts`，`tests/integration/bootstrapApp-resume.test.ts`

**依赖：** T4、T7、T9

**测试先行：**

1. 集成测试：构造可观察的 `systemPromptRegistry`，传入 mock `bootstrapApp`，断言 `ChatSessionController` 收到的 `systemPromptRegistry` 中 `project-rules` slot 非空且包含 `AGENTCODE.md` 标记文本。
2. 集成测试：构造含历史记录的 `RestoredSession` mock，断言 `initialProviderContext` 在 `renderApp` 之前已传入 controller。
3. 运行测试，预期因 `resumeMode` 未实现而失败。
4. 实现 `bootstrapApp` 中的编排逻辑：
   - 并行：`loadDynamicModules(cwd, homeDir)` + `SessionCleaner.maybeClean(cwd)`（void，不 await）
   - 若 `resumeMode`：调用 `ResumeSelector.pickSession(cwd)`，获取 `restoredSession`
   - 构造 `SessionArchive`、`AutoNoteWriter`
   - 传入 `ChatSessionController`
5. 实现 `main.ts` 中 `process.argv` 解析：检测 `--resume`，调用 `bootstrapApp({ resumeMode: true })`；否则走原有 `runCli()` 路径。
6. 重跑测试，预期通过。
7. 运行 `npm run typecheck`，预期通过。

**回归验证：** 运行 `npm test && npm run typecheck`，如环境允许运行 `npm run e2e:tmux`（带 `--resume`）验证 TUI 历史恢复可见。

**任务后审查：** 高风险（顶层编排 + CLI 入口），3 个只读 reviewer。

---

## 执行顺序

```text
T1 ──────────────────────────────────────────────────┐
T2 (与 T3、T5 并行) ──────────────────────────────── T4 ──── T9 ──── T10
T3 (与 T2、T5 并行) ──────────────────────────────── T4
T5 (与 T2、T3 并行) ──────────────────────────────── T9
T6 ───────────────────── T7 ──────────────────────── T10
T8 ────────────────────────────────────────────────── T9
```

简化表达：

```text
[T1, T2, T3, T5, T6] 可并行启动（无相互依赖）
T4 依赖 T1 + T2 + T3
T7 依赖 T6
T8 依赖 T3（loadMemoryIndex 接口）
T9 依赖 T5 + T8
T10 依赖 T4 + T7 + T9
```
