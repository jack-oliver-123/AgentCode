---
name: submit-pr
description: 当用户要求为 AgentCode 草拟、审查、检查或发布 PR 时使用。提到“写 PR 标题/描述”“检查能否提 PR”进入只读模式；明确要求 push、创建、更新或发布 PR 时进入发布模式。所有 PR 发布都必须使用本 Skill，其他 Skill 必须转交。
---

# Submit PR

## 核心原则

本 Skill 是所有 PR 发布操作的唯一入口。其他 Skill 可以完成诊断、修复或实现，但需要 push、创建或更新 PR 时，必须 handoff 给本 Skill，不得自行执行。

发布意图不等于写入授权。先完成只读预检和质量门禁，展示完整发布预览，再取得针对该预览的明确确认。确认前不得执行首次远端写操作。

## 先判定模式

| 模式 | 典型请求 | 允许的动作 |
|---|---|---|
| 只读草稿/审查 | “写 PR 标题和描述”“检查能不能提 PR”“review PR 草稿” | 读取本地 Git 状态和必要的 GitHub 元数据，返回草稿或检查结果 |
| 发布 | “push 并创建 PR”“开 PR”“更新 PR”“发布这个分支” | 先只读预检、验证和预览；用户确认后才 push 并创建或更新 PR |

无法确定模式时，采用只读模式并说明未执行写操作。

### 只读模式是绝对只读

只读模式中禁止：

- 调用可能修改文件的 `simplify`
- 编辑、格式化、生成或删除仓库文件
- `git add`、`git commit`、`git stash`、`git reset`、`git checkout`
- `git push`
- `gh pr create`、`gh pr edit`、`gh pr close` 或其他 PR 写操作

用户只要求草稿时，输出标题和正文草稿后停止。不要把“写 PR 描述”扩大成代码复盘或发布。

## 发布模式：只读预检

以下步骤均在任何代码修改、commit、push 或 PR 写操作之前执行。

### 1. 解析仓库与分支

只读获取并记录：

```bash
git rev-parse --show-toplevel
git remote get-url origin
gh repo view --json nameWithOwner,url,defaultBranchRef
git symbolic-ref --quiet --short HEAD
git branch --show-current
git status --porcelain=v1 --untracked-files=all
```

- 没有 Git 仓库、没有 `origin`、无法解析默认分支时停止。
- 从 `gh repo view` 的 `defaultBranchRef.name` 动态取得 `base`；不得假定它是 `main`。
- `git symbolic-ref` 失败或当前分支名为空表示 detached HEAD，立即停止。
- 当前分支等于 `base` 时立即停止，要求用户先创建独立分支。
- 工作树输出非空时立即停止并保留用户改动。不得自动 stash、stage、commit、reset、checkout、清理文件或调用 `simplify`。
- dirty worktree 时请用户自行处理，或明确选择在隔离 worktree 中继续；没有该选择不得代为隔离。

确认本地存在动态 base 的远端跟踪引用：

```bash
git show-ref --verify "refs/remotes/origin/${base}"
```

不存在或明显过期时停止，说明需要更新远端引用；不要在只读预检中擅自 `fetch`。取得单独授权并更新后，从头重跑预检。

### 2. 读取改动事实

所有比较都使用动态 base：

```bash
git log --oneline "origin/${base}..HEAD"
git diff --stat "origin/${base}...HEAD"
git diff "origin/${base}...HEAD"
```

没有可发布的 commit 时停止。按最终 diff 说明改了什么、为什么改，不要把 commit message 直接堆成 PR 正文。

### 3. 检查已有 PR

在预览前只读查询当前 head 的所有 PR：

```bash
gh pr list --head "${head}" --state all --json number,url,state,title,baseRefName,headRefName
```

- 存在 open PR：预览操作必须写“更新 PR #N”，确认后使用 `gh pr edit`。
- 不存在 PR：预览操作写“创建 PR”。
- 只有 closed/merged PR：停止并向用户说明，由用户决定是否允许新建；不要自行重复创建。
- 多个候选或 base/head 不一致：停止并要求用户选择。

## `simplify` 与代码修改授权

PR 请求本身不授权修改代码。`simplify` 默认不运行，只有用户另行明确授权“允许 `simplify` 修改本分支代码”时才可调用：

```text
Skill(skill="simplify")
```

- 只读草稿模式绝不调用 `simplify`。
- 运行后先只读展示实际 diff；不得自动 stage 或 commit。
- `simplify` 的修改必须重新执行完整预检和全部适用验证。
- commit 是另一项独立授权。只有用户明确允许提交后，才能按具体文件 stage 并 commit；禁止 `git add .` 和 `git add -A`。
- commit 后再次执行完整预检和验证，再生成新的发布预览。旧确认自动失效。

## Issue 关联语义

分支名、commit message、代码注释或其他文本里的 `#数字` 都只是候选，不代表关联关系，更不代表关闭语义。代码注释绝不能自动生成 `Closes`。

对每个候选逐项只读核验：

```bash
gh issue view "${issue_number}" --json number,title,state,body,url
```

向用户展示候选编号、来源、issue 标题/状态、与 diff 的关系及建议语义：

- 只有用户明确确认“本 PR 完整解决该 issue”时，才能写 `Closes #N`。
- 相关但未完整解决、无法确认或只是背景信息时，写 `Refs #N`。
- 无关编号不写入 PR。
- 不得根据 `fix`、`refs`、分支名或评论自行升级为 `Closes`。

发布预览必须列出每个候选的最终语义；没有用户确认时一律不得使用 `Closes`。

## 质量门禁与证据

根据 `origin/${base}...HEAD` 的最终 diff 判断是否有代码变更。先读取 `package.json` 的实际 scripts；只要有代码变更，当前项目必须实际运行：

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run e2e:tmux
```

判定与记录规则：

- typecheck 以退出码为 0 且没有 TypeScript 诊断为通过；不要求工具打印字面量 `0 errors`，PR 正文也不得虚构该输出。
- lint、build 和测试以实际退出码及输出为证据。typecheck、lint、build、单元/集成测试失败时停止发布。
- E2E 功能失败时停止。环境不可用时保持未通过、记录命令和具体阻塞，不得写成通过；是否带阻塞发布只能由用户在发布预览后明确决定。
- 文档等非代码变更可将不适用项保持未勾选并写明原因，不得伪装成已运行。
- manifest 以后发生变化时以当时的 `package.json` 为准；不得运行不存在的脚本，也不得声称运行了未执行的 lint。

### 测试覆盖证据

tests 目录是否有 diff 既不是必要条件，也不是充分条件。对每项变更行为建立证据映射：

| 变更行为 | 具体测试文件 | 测试/断言名称 | 实际命令与结果 |
|---|---|---|---|
| 行为 X | `tests/...` | `it/test ...` | 命令、exit 0 |

- 既有测试可以证明覆盖，但必须读取具体测试/断言并实际运行相关命令。
- 新行为没有对应证据时停止，先报告覆盖缺口；不要未经授权新增测试。
- PR 正文列出实际提供证据的测试文件，包括未修改但用于证明覆盖的既有测试。

## 标题与正文

标题使用 `type(scope): 中文描述`，总长度不超过 70 个字符。type 使用 `feat`、`fix`、`refactor`、`chore`、`docs`、`test` 或 `perf`；scope 使用项目实际子系统英文名。

正文只陈述可由 diff 和验证结果支持的事实：

```markdown
## 改了什么

### src/[子系统]
- `模块名`：改了什么，原因是什么

## 关联 issue

Refs #N
Closes #M（仅限用户已确认完整解决）

## 验证

- [x] `npm run typecheck` — exit 0，无 TypeScript 诊断
- [x] `npm run lint` — exit 0，无 lint 诊断
- [x] `npm run build` — exit 0
- [x] `npm test` — exit 0；覆盖证据：`tests/...` 的 `测试名称`
- [ ] `npm run e2e:tmux` — 未通过；具体环境阻塞：[事实]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

checkbox 必须反映事实：实际通过才写 `[x]`；失败、未运行、环境阻塞或不适用均写 `[ ]` 并说明。

## 发布预览与确认门

在首次 `git push`、`gh pr create` 或 `gh pr edit` 前，向用户完整展示：

1. 仓库与 origin
2. `base` 与 `head`
3. 操作类型：创建 PR 或更新 PR #N
4. 最终 title
5. 完整 body
6. 每个 issue 候选及 `Refs` / `Closes` / 不关联的语义
7. typecheck、build、测试、E2E 的命令、退出状态和覆盖映射
8. 未通过、未运行、不适用项及具体阻塞
9. 即将执行的写操作

然后明确询问用户是否按这份预览发布。用户最初说“推送并创建 PR”只表示进入发布模式，不是对尚未展示内容的确认。

只有用户在预览后明确同意，才能解锁首次远端写入。含糊回复、沉默或只确认其中一项都不算授权。预览后若 commit、diff、base、head、title、body、issue 语义或验证状态变化，旧确认立即失效；重跑相关检查、重新预览并再次确认。

## 确认后的安全发布

### 1. 准备安全输入

在系统临时目录创建仅当前用户可访问的独立临时目录。创建前后都要验证目录不是符号链接、junction 或其他 reparse point，并把 `title.txt`、`body.md` 权限限制为 owner-only。使用 Claude Code 的文件写入工具写入最终 title 和完整 body；不要用 `echo`、HEREDOC、命令替换或字符串拼接把用户/仓库内容嵌入 shell。

随后从标题文件读取安全变量，正文始终使用 `--body-file`：

```bash
title_file="/已创建的临时目录/title.txt"
body_file="/已创建的临时目录/body.md"
IFS= read -r title < "${title_file}"
```

### 2. 推送 head

确认仍在预览过的 commit、分支和干净工作树后，只使用：

```bash
git push -u origin HEAD
```

永不使用 `--force`、`--force-with-lease` 或 `--no-verify`。push 失败时停止，不得尝试绕过保护。

### 3. 创建或更新

push 后再次只读检查已有 PR，防止并发重复创建。所有变量都加引号；PR 正文只通过文件传入。

没有 open PR 时：

```bash
gh pr create --base "${base}" --head "${head}" --title "${title}" --body-file "${body_file}"
```

已有 open PR 时：

```bash
gh pr edit "${pr_number}" --base "${base}" --title "${title}" --body-file "${body_file}"
```

不得把 title、body、issue 内容或日志直接拼入 shell 命令。完成后用 `gh pr view` 只读回查 base、head、title、body 和 URL；不一致时报告并停止，不要继续写。无论成功或失败，都在 finally 清理本次创建的两个明确临时文件和私有临时目录；路径验证失败时不删除任何内容。最后向用户返回 PR URL 与验证摘要。

## 硬停止速查

遇到以下任一情况立即停止发布：

- detached HEAD、当前分支等于默认分支或工作树不干净
- origin、默认 base 或 `origin/${base}` 无法可靠解析
- 没有可发布 commit，或已有 PR 状态/数量存在歧义
- typecheck、build、测试失败，或 E2E 出现真实功能失败
- issue 的 `Closes` 语义未经用户确认
- 发布预览尚未展示，或展示后尚未取得明确确认
- 预览内容在确认后发生变化

停止时保留用户现状，说明阻塞和下一步；不得自动修改、提交、切分支或绕过门禁。
