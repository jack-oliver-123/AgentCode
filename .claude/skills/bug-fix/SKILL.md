---
name: bug-fix
description: |
  AgentCode 项目的 bug 修复流程。当用户报告 bug、描述异常/非预期行为、粘贴错误日志或 stack trace、
  粘贴编译错误或测试失败输出、提及崩溃/回归/降级/性能问题、或要求修复代码缺陷时使用此 skill。
  覆盖：复现确认、根因定位、创建 GitHub issue、实现修复、构建与测试验证。
  触发关键词（中文）：bug、错误、报错、异常、崩溃、不对、坏了、挂了、炸了、回归、
  之前好的现在不行了、升级后失效、跑不起来、跑不通、不生效、失灵、白屏、死循环、
  慢、卡、卡顿、无响应、超时、内存泄漏、内存暴涨、CPU 飙高、又出现了、修了没好。
  触发关键词（英文）：not working、broken、error、crash、regression、unexpected behavior、
  something broke、doesn't work、failing、failed、hang、freeze、timeout、memory leak、
  slow、unresponsive、still broken、stopped working、misbehaving、issue（指 bug 而非 GitHub 操作）、
  glitch、flaky、intermittent、exception、panic、OOM、out of memory、high CPU、
  latency、performance degradation、ENOENT、EACCES、ERR_。
  裸输出触发：当用户消息主体是一段错误日志、stack trace、编译失败输出或测试失败输出，且未明确说明意图时，默认按 bug 报告处理并触发此 skill。
  判断指引：如果用户描述的现象包含"预期 vs 实际"的差异，即使措辞像是在问原理，也应触发。
  如果用户说"这里有个问题"后跟的是代码片段+异常现象→触发；后跟"我不理解为什么这样写"→不触发。
  优先级：当用户描述同时可能匹配 bug-fix 和 refactor/code-review 时，如果存在明确的异常现象或错误输出，优先触发 bug-fix。
  不触发：用户仅做代码审查（无异常现象）、询问实现原理（不涉及异常）、提出新功能需求、或讨论架构设计时，不应使用此 skill。
---

# Bug Fix — AgentCode

本 skill 指导完成 AgentCode 项目的 bug 修复全流程。

核心原则：先复现再分析，先建 issue 再改代码，修完必须构建和测试验证。

## 流程概览

1. **复现与定位** — 确认 bug 存在，找到根因
2. **设计修复方案** — 确定改什么、怎么改
3. **创建 Issue** — 在 GitHub 记录问题和修复方案，等待用户确认
4. **实现修复** — 写出干净的修复代码
5. **构建与验证** — 构建通过 + 测试 + 手动复现确认修复有效
6. **提交与交付** — push 到远端，创建 PR

**多 bug 报告处理：** 如果用户一次报告了多个独立问题，每个问题单独走流程、单独建 issue；如果是同一根因的多个表现，合并为一个 issue 一次修复。

---

## 第一步：复现与定位

### 收集信息

从用户描述中提取：
- 具体现象（错误信息、异常行为、预期 vs 实际）
- 触发条件（什么操作、什么输入、什么环境）
- 是否可稳定复现

如果用户描述不充分，主动询问以下标准问题：
- 当前分支和 commit（是否在最新 main 上）
- Working tree 是否 clean
- Node/npm 版本
- 配置文件内容（要求脱敏，不暴露 API key）
- 完整错误输出或 stack trace

### 尝试复现

在动手分析代码之前，先实际复现 bug 确认现象存在。按 bug 类型选择复现方式：

| Bug 类型 | 复现方式 |
|----------|----------|
| CLI 启动类 | `npm run dev` 或 `node dist/cli/main.js` 直接运行 |
| Provider/流式类 | 启动 mock server + 运行相关集成测试或 E2E |
| TUI 渲染类 | `npm run dev` 在真实终端观察 |
| 工具执行类 | 运行对应单元测试，或写最小复现脚本 |
| 配置/首次启动类 | 临时移除 `.agentcode/` 目录重新触发初始化路径 |

复现结果：
- 如果能复现：记录复现步骤和错误输出，作为修复后的对比基准，然后进入根因分析
- 如果无法复现：向用户请求更多信息，或建议增加 debug 日志后再次触发。不要在没有复现证据的情况下盲目改代码

### 定位根因

按以下顺序排查：

1. **读相关代码** — 根据症状定位到具体模块：
   - CLI/启动问题 → `src/cli/`
   - 配置问题 → `src/config/`
   - Provider/流式问题 → `src/providers/`
   - 工具执行问题 → `src/tools/`
   - TUI 渲染问题 → `src/tui/`
   - Agent Loop 问题 → `src/agent/`
   - 会话控制问题 → `src/session/`

2. **查相关测试** — 看 `tests/` 下对应的测试文件是否已覆盖该场景（测试位于 `tests/unit/<模块名>/`，文件名与源文件对应，后缀 `.test.ts`）

3. **检查踩坑记录** — CLAUDE.md 的"踩坑记录"里可能有相同或相似的问题

4. **运行 typecheck** — `npm run typecheck` 排除类型错误

5. **检查同类问题** — 根因确认后，搜索项目中是否存在相同模式的潜在 bug（同一个错误可能在多处出现）

### 输出根因分析

明确说明：
- 问题出在哪个文件的哪段逻辑
- 为什么会产生这个 bug（逻辑错误、边界条件、类型问题、竞争条件等）
- 影响范围（只影响特定场景 vs 影响核心流程）
- 是否存在同源问题需要一并修复

---

## 第二步：设计修复方案

在写 issue 之前，先明确：
- 需要修改哪些文件
- 修复策略：patch（最小改动）还是 refactor（重构设计缺陷）
- 是否需要新增或修改测试
- 是否涉及新增/升级依赖

这一步的输出将作为 issue "修复方案" 部分的内容。

---

## 第三步：创建 GitHub Issue

**这是强制步骤。**

例外条件（全部满足才可跳过）：
- ① 用户明确说"直接改"
- ② 修改不超过 3 行
- ③ 修改为 typo/格式级别

紧急例外：P0 阻塞性 bug（如 CLI 完全无法启动、所有用户核心流程中断），可先修复再补 issue 记录。P0 修复 push 后 24 小时内必须补建 issue，且 commit message 中标注 `[P0-PENDING-ISSUE]` 便于追踪。

即使跳过 issue 创建，也需在 commit message 中说明原因。

### Issue 模板

```
标题：简明描述 bug（如 "流式 tool call delta 空字符串导致协议错误"）

正文：
## 现象
<用户看到的具体错误或异常行为>

## 复现步骤
<如何触发这个 bug>

## 根因分析
<代码层面的问题原因>

## 修复方案
<计划怎么修，改哪些文件，patch vs refactor>

## 影响范围
<这个修复会影响哪些模块/功能>
```

命令：`gh issue create --label bug --title "..." --body "..."`

**注意：** issue 正文中禁止包含实际 API key 或 secret 值，仅引用 key name。

### 等待用户确认

Issue 创建后，向用户展示修复方案摘要并等待确认。如果用户在最初的消息中已明确授权修复（如"帮我修了吧"），可直接进入下一步。

---

## 第四步：实现修复

### 原则

- **最小化修改** — 只改必须改的代码，不顺手重构无关部分
- **匹配现有风格** — 代码注释用中文（除非周围已是英文），遵循项目既有模式
- **注意接口影响** — 修改公共接口后，全局搜索所有 mock/stub 实现并同步更新（参考踩坑记录）

**原则冲突裁决：** 如果 bug 根因是设计缺陷（而非逻辑疏忽），且最小化 patch 会让代码变得更脏或引入更多技术债，则按 CLAUDE.md 底线规则执行 — "该重构就重构，干净的设计比向后兼容重要"，"不保留过渡代码，如果新设计更好，直接替换旧实现"。此时在 issue 的修复方案中说明重构范围和理由。

### 修复步骤

1. 从 main 最新状态创建修复分支：
   ```bash
   git checkout main && git pull origin main && git checkout -b fix/<issue简述>
   ```
   如果远端已有同名分支，加序号后缀（如 `fix/<issue简述>-2`）或提示用户处理。

2. 实现修复代码
3. 如果修复涉及新的边界条件，补充对应的单元测试
4. 确保 typecheck 通过：`npm run typecheck`

### 需要特别注意的项目约束

- `exactOptionalPropertyTypes` 已开启 — 可选字段不能直接赋 undefined，用 spread 模式
- 工具 schema 避免复杂嵌套（OneAPI 代理网关兼容性问题）
- OpenAI 兼容层 delta 中 `name`/`id` 空字符串要当作"无更新"处理

### 依赖变更要求

如果修复涉及新增或升级 npm 依赖：
- 使用精确版本号（非 `^` / `~`）
- 确认包名无 typosquatting 风险（检查 npm 官方页面、下载量、维护者）
- 优先选择已在项目中使用的依赖生态

### 安全禁令

- **禁止** `git push --force` 或任何 force 操作
- **禁止** 直接推送到 main 分支
- **禁止** 修改 `.agentcode/config.yaml` 或 `.env` 中的实际 API key/密钥值
- **禁止** 在代码、输出、issue 正文、commit message 或 PR body 中暴露 secret — 仅引用 key name
- **禁止** 对已 push 到远端的 commit 执行 reset
- **禁止** 读取 `.agentcode/config.yaml`、`.env` 等含 secret 的文件后在响应中回显实际密钥值 — 仅引用 key name（如 `api_key`）
- **禁止** 修改 `.gitignore` 以取消对敏感目录（`.agentcode/`、`.env` 等）的忽略规则
- **禁止** 创建新的含明文 secret 的配置文件
- **禁止** 执行来源不明的第三方脚本 — 修复过程中如需运行项目外脚本，必须先阅读脚本内容确认无恶意行为

### reset 操作安全检查

执行 `git reset` 前必须先确认 commit 未被 push：
```bash
git log origin/<branch>..HEAD
```
仅当上述命令显示有本地未推送的 commit 时才可 reset。如果命令无输出（说明已 push），禁止 reset。

### 修复尝试上限

如果 3 次根本性不同的修复方案均验证失败，停止修改代码，向用户报告：
- 已尝试的方案及每次失败原因
- 当前对根因的最佳理解
- 建议的下一步方向（如请求人工介入、pair debug、或更换技术路线）

---

## 第五步：构建与验证

### 按影响范围选择验证级别

**小改动**（单文件逻辑修复、边界条件补丁）：
```bash
npm run typecheck
npm run build
npm test -- tests/unit/<相关测试文件>
```
注意：即使是小改动，如果修改的是被广泛引用的工具函数/公共接口，应升级为"中等改动"验证。

**中等改动**（跨模块、接口变更）：
```bash
npm run typecheck
npm run build
npm test
```

**大改动**（核心流程、Provider 协议、Agent Loop）：
```bash
npm run typecheck
npm run build
npm test
# E2E 前先检查环境
command -v psmux || command -v tmux
npm run e2e:tmux
```

### 复现验证闭环

验证的最后一步：用第一步记录的复现步骤重新执行，确认原始 bug 现象已消失。自动化测试通过不能完全替代这一步 — 测试验证的是代码正确性，复现验证确认的是用户体验恢复。

### 验证标准

- typecheck 零错误
- build 成功（`npm run build` 无报错）
- 相关测试全部通过
- 如果修复了一个之前没有测试覆盖的 bug，至少新增一个测试用例覆盖该场景
- E2E 测试（如运行）确认 CLI 流程正常
- 原始复现步骤不再触发 bug

### 关于 flaky 测试的判断

仅当以下条件全部满足时，可视为 flaky 而非真实失败：
- 失败测试为 `write-file.test.ts`、`run-command.test.ts`、`edit-file.test.ts` 之一（此列表截至 task04，如有变化以 CLAUDE.md 踩坑记录为准）
- 错误信息与文件锁、timeout、或 EBUSY/ENOENT 竞争条件相关
- 单独运行该测试能通过

其他任何测试失败都必须排查，不得以"flaky"为由跳过。

### 验证失败时

如果验证不通过：
1. 回到修复代码重新分析问题
2. 如果连续两次修复尝试失败，重新审视根因分析是否正确，考虑是否有更深层的设计问题
3. 需要撤回 commit 时，先执行 `git log origin/<branch>..HEAD` 确认 commit 未 push，然后才可 `git reset --soft HEAD~1`；也可用 `git stash` 保存当前进度
4. 在 issue 中补充新发现的信息
5. 如果 3 次根本性不同的修复方案均失败，执行"修复尝试上限"中的退出策略

### 注意事项

- E2E 需要 psmux/tmux 可用；`command -v psmux || command -v tmux` 失败时必须明确记录为环境阻塞，不要声称 E2E 已通过
- 不要声称已通过未实际运行的测试

---

## 第六步：提交与交付

修复验证通过后：

1. **Commit**：
   ```bash
   git add <修改的文件>
   git commit -m "fix: <简述> (closes #<issue号>)

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
   ```
   （Co-Authored-By 格式按 CLAUDE.md 中 git commit message 规范填写）

2. **Push 前 secret 扫描**：
   ```bash
   # 检查 diff 中是否意外包含 secret 模式（关键词 + 值模式）
   git diff main..HEAD | grep -iE "(api_key|secret|token|password|credential)\s*[:=]|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[A-Z0-9]{16}" && echo "⚠️ 可能包含 secret，请检查后再 push" || echo "✅ 未发现 secret 模式"
   ```
   如果扫描命中，必须检查是否为误报（如变量名引用而非实际值）。确认无 secret 后再 push。

3. **Push 到远端**：
   ```bash
   git push -u origin fix/<issue简述>
   ```

4. **创建 PR**：
   ```bash
   gh pr create --title "fix: <简述> (closes #<issue号>)" --body "## 修复内容
   <简要说明修了什么>

   ## 验证
   <运行了哪些测试，结果如何>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)"
   ```

4. 如果 bug 有通用教训，建议更新 CLAUDE.md 的踩坑记录

5. 向用户汇报修复结果和验证证据
