# 会话记忆与指令系统 Checklist

## 绑定输入

- spec.md: 4adea65de6e1d10e035d8cec7e0e262f5d31fc19
- plan.md: 28a7730e0991ca04a7293bd95a35c57e4159f2f9
- tasks.md: a1a1104302613fd853ca456cb5dadc4e9e694ffd

## 需求行为

- [x] AC1（对应 F1）：`project-rules` slot 三层加载顺序正确（验证：`npm test -- tests/unit/system-prompt/loadProjectRules.test.ts`；预期：`.agentcode/AGENTCODE.md` 内容在 `AGENTCODE.md` 内容之前，全局层在最后；三层均缺失时返回空字符串且无报错）

- [x] AC2（对应 F2）：`@include` 展开与安全边界（验证：`npm test -- tests/unit/system-prompt/loadProjectRules.test.ts`；预期：项目内路径被展开；跳出 projectRoot 的路径触发 warn 日志且内容不含目标文件；全局文件 `@include` 目标在 `~/.agentcode/` 外时同样 warn 跳过；A→B→A 环路不死循环；5 层嵌套时第 5 层内容不出现）

- [x] AC3（对应 F4）：会话 JSONL 写入格式正确（验证：`npm test -- tests/unit/session/SessionArchive.test.ts`；预期：每行合法 JSON；user/assistant 文本行含 `_ts`、`_ui`；工具调用行含 `toolCalls` 无 `_ui`；工具结果行含 `toolCallId`、`toolName`、`isError` 无 `_ui`；追加不覆盖旧行）

- [x] AC4（对应 F5+F6）：会话恢复异常处理（验证：`npm test -- tests/unit/session/SessionRestore.test.ts`；预期：坏行跳过；孤立工具调用后截断；有效历史正确重建为 `ChatMessage[]`；24h 断点处存在合成 `role: user` 提醒消息）

- [x] AC5（对应 F7）：惰性清理非阻塞（验证：`npm test -- tests/unit/session/SessionCleaner.test.ts`；预期：`last_cleanup` 超 7 天时触发删除 mtime > 30 天的文件；函数返回 Promise 且调用方不 await；`last_cleanup` 写回当前 ISO 8601 时间戳）

- [x] AC6（对应 F8+F9+F10）：自动笔记触发与写入（验证：`npm test -- tests/unit/notes/AutoNoteWriter.test.ts`；预期：关键词路径触发并生成 `metadata.type: feedback` 笔记；`completionTokens=300` + 代码围栏路径也触发；`completionTokens=300` 无代码围栏不触发；`MEMORY.md` 索引行数 ≤ 200）

- [x] AC7（对应 F11）：上下文注入顺序（验证：`npm test -- tests/integration/bootstrapApp-resume.test.ts`；预期：`project-rules` slot 非空且包含 `AGENTCODE.md` 标记文本；`initialProviderContext` 传入前 `ContextManager.onMessagesAppended` 已调用）

- [x] AC8（对应 N2）：`@include` 路径安全（验证：`npm test -- tests/unit/system-prompt/loadProjectRules.test.ts`；预期：跳出 `projectRoot` 的路径抛出 Error；warn 日志含路径信息；整体加载不崩溃）

## 集成与回归

- [x] system-prompt 模块回归（验证：`npm test -- tests/unit/system-prompt/`；预期：全量通过，无因新增 `project-rules` slot 破坏的现有测试）

- [x] ChatSessionController 回归（验证：`npm test -- tests/unit/session/`；预期：全量通过；`completeTurn` async 改造不破坏现有 `for await` 事件循环）

- [x] bootstrapApp 编排回归（验证：`npm test -- tests/integration/`；预期：无 `--resume` 时启动行为与改动前一致；`SessionCleaner` 非阻塞不影响启动时间）

- [x] defaultRegistry mock 完整性（验证：`npm run typecheck`；预期：所有引用 `defaultRegistry` 的 mock/stub 已补充 `project-rules` 条目，无编译缺失属性错误）

## 构建与测试

- [x] 全量测试通过（验证：`npm test`；预期：所有单元+集成测试绿色）

- [x] 类型检查通过（验证：`npm run typecheck`；预期：零类型错误）

- [x] Lint 通过（验证：`npm run lint`；预期：零 Biome 警告/错误）

## 安全、权限与回滚

- [x] `@include` 路径安全（在 Linux/macOS 上验证：`@include ../../etc/passwd` 返回 warn 日志条目，不读取目标内容；整体加载继续）

- [x] 目录权限正确（在 Linux/macOS 上验证：`SessionArchive` 创建的 `sessions/` 目录权限为 `0o700`；写入的 JSONL 文件权限为 `0o600`；`AutoNoteWriter` 创建的 `memory/` 目录权限为 `0o700`；笔记文件权限为 `0o600`。Windows 平台跳过权限断言，记录为环境差异）

- [x] 回滚步骤可执行（验证：删除 T1 对 `registry.ts` 的新增条目，运行 `npm run typecheck`，确认回滚后现有功能恢复；所有新建文件可单独删除不影响主流程）

- 平台差异：本次验收在 Windows 完成；POSIX mode 和 symlink 专属断言按清单约定跳过，越界路径与 Windows junction 安全用例已通过。
- 回滚记录：临时移除 `project-rules` 注册项后 `npm run typecheck` 通过；恢复注册项后再次通过，工作区未保留临时回滚。

## 端到端

- [x] 基础启动（验证：`npm run dev`，发送一条消息；预期：`.agentcode/sessions/` 下生成 JSONL 文件，文件每行合法 JSON）

- [x] `--resume` 恢复流程（验证：`npm run dev -- --resume`，通过 readline 选择历史会话；预期：TUI 中历史消息可见，新发消息正常响应）

- [x] AGENTCODE.md 加载（验证：在项目根写入 `AGENTCODE.md` 含标记文本，启动 `npm run dev`；预期：Agent 能感知其中规则，第一轮回复中可见其影响）

- [x] 自动笔记生成（验证：发送含"以后记住，不要用 any 类型"的消息；预期：`.agentcode/memory/` 下生成笔记文件，`MEMORY.md` 索引出现对应条目）

- [x] E2E smoke 测试（验证：`npm run e2e:tmux`；预期：通过；若 psmux/tmux 不可用，记录为环境阻塞）

## 验收记录

- 变更集范围：`src` + `tests`
- 当前变更集 hash：`51ebde471b8d12121699e2052c53ee3194464b3db8c0e9d99b28c7550b64d3a1`
- 验收环境：Windows 11 / PowerShell / Node.js；E2E 使用 Git Bash + psmux。

| 条目 | 当前变更集 hash | 实际结果 | 证据 | 状态 |
|------|-----------------|----------|------|------|
| AC1 三层加载 | `51ebde47…d3a1` | 三层顺序、缺失容错通过 | `loadProjectRules.test.ts`；全量测试 724 passed | 通过 |
| AC2 @include 安全 | `51ebde47…d3a1` | 展开、越界、环路、深度限制通过 | `loadProjectRules.test.ts` | 通过 |
| AC3 JSONL 写入 | `51ebde47…d3a1` | schema、追加、恢复续写通过 | `SessionArchive.test.ts`；E2E JSONL 校验 | 通过 |
| AC4 会话恢复异常 | `51ebde47…d3a1` | 坏行、工具对、时间断点通过 | `SessionRestore.test.ts`；E2E resume | 通过 |
| AC5 惰性清理 | `51ebde47…d3a1` | 7/30 天阈值和失败处理通过 | `SessionCleaner.test.ts` | 通过 |
| AC6 自动笔记 | `51ebde47…d3a1` | 两类触发、原子写、索引裁剪通过 | `AutoNoteWriter.test.ts`；E2E 笔记落盘 | 通过 |
| AC7 注入顺序 | `51ebde47…d3a1` | 规则与恢复上下文注入通过 | `bootstrapApp-resume.test.ts` | 通过 |
| AC8 路径安全 | `51ebde47…d3a1` | 越界、junction、hardlink 防护通过 | 单元安全用例；Windows 平台记录 | 通过 |
| 全量测试 | `51ebde47…d3a1` | 58 文件，724 passed，3 skipped | `npm test` | 通过 |
| 类型检查 | `51ebde47…d3a1` | 零类型错误 | `npm run typecheck` | 通过 |
| E2E smoke | `51ebde47…d3a1` | 规则加载、归档、resume、自动笔记全通过 | `npm run e2e:tmux` | 通过 |
