---
name: submit-pr
description: AgentCode 项目的 PR 提交质量门禁——把改动事实 + issue 关联说清楚、跑类型检查、跑测试、符合项目规范。当用户说「提交 PR」「开 PR」「创建 PR」「提个 PR」「写 PR 描述」「push 完开 PR」「这个分支可以 review 了」时务必使用，不要自己手撸跳过门禁。仅在用户明确提到 PR 时使用，单纯的 git commit / git push 不要触发。
---

# Submit PR

提交 PR 不是写得漂亮，是把质量门禁过了。本 skill 的核心是 **门 0 + 3 道门**，不是文采。

## 门 0：先跑 simplify 复盘改动（强制前置，不能跳过）

进入任何后续门之前，**第一件事**就是调用 simplify skill 对本分支改动做一次质量复盘：

```
Skill(skill="simplify")
```

simplify 会并行跑 3 个 review agent（reuse / quality / efficiency），把改动里的重复代码、hacky 模式、低效写法挑出来并就地修掉。

执行要求：

- **必须真跑**，不能 "我看了一眼觉得没问题" 就跳过
- simplify 跑完如果**改了文件**，先 `git status` / `git diff` 看清楚改了哪些地方，再 `git add <按文件名> && git commit` 把复盘修复作为独立 commit 落地（commit message 建议 `refactor: simplify 复盘修复` 或类似）
- simplify 报告里**确认为假阳性的项**，在心里记下原因，不要再花时间反复纠结
- 如果 simplify 完成时**未做任何修改**，说明改动已够干净，直接进门 1

simplify 复盘是为了让进入门 1-3 的代码本身值得过门禁——别让 reviewer 替你做 simplify 的活。

## 3 道门（按顺序过，缺一不可）

### 门 1：把改了什么 + 关联 issue 写清楚

读 git log + diff，从事实出发，写一个清单——**改了什么**，**关联哪些 issue**。

```bash
git status                                   # 是否还有未提交改动
git branch --show-current                    # 当前分支名
git log main..HEAD --oneline                 # 本分支所有 commit
git diff main...HEAD --stat                  # 文件改动总览
```

提取信息：

- **改动清单**：按子系统列（`src/agent` / `src/mcp` / `src/tools` / `src/tui` / `src/config` / `src/session` / `src/providers` / `tests` / `docs` 等），每条说「改了什么文件 / 模块」「为什么改」。事实陈述，不要营销话术
- **issue 关联**：搜分支名、commit message、改动注释里的 `#数字`，统一在 PR body 里写 `Closes #X`（每个 issue 独立一行）。没找到就明确写「本次未关联 issue」，不要硬编

### 门 2：类型检查必须通过

只要改了 `src/**` 下的任何 TypeScript 文件，必须真跑：

```bash
npm run typecheck
```

- 输出 `0 errors` 才算通过
- 有错误 → **不能提 PR**，先修了再回来
- Test plan 里的对应行才能勾 `[x]`

### 门 3：测试必须通过且有覆盖

只要改了 `src/**` 下的实现文件，必须满足：

1. **改动有对应测试**：
   - 改了已有模块 → 要么已有测试覆盖改动路径，要么本次新增 / 修改测试
   - 新建模块 → 必须配套新建测试文件（`tests/unit/` 对应路径下）
   - 用 `git diff main...HEAD --stat -- 'tests/'` 验证有测试改动
2. **`npm test` 必须全部通过**：
   - 失败 → 不能提，先修
   - 因文件系统竞争导致的偶发 flaky（见 CLAUDE.md 踩坑记录）可单独验证后注明

PR body 的「验证」段必须列出**新增 / 修改的测试文件名**，不只是「npm test 通过」一句话。

## 3 道门都过了之后

### 写 PR title + body

**Title 格式**：`type(scope): 中文描述`

- type：`feat` / `fix` / `refactor` / `chore` / `docs` / `test` / `perf`
- scope：子系统英文（`agent` / `mcp` / `tools` / `permissions` / `tui` / `config` / `session` / `providers` / `system-prompt` / `e2e` 等）
- 描述中文，整个 title ≤ 70 字符

**Body 模板**（按这个骨架填，没内容的段就不要加，不要写「无」/「N/A」占位）：

```markdown
## 改了什么

### src/[子系统]
- `**模块名**`：改了 X，原因是 Y
- ...

### tests/
- 新增 / 修改 `XxxTest.ts`：覆盖 [场景]
- ...

### docs/（如有）
- ...

## 关联 issue

Closes #X
Closes #Y

（或写：本次未关联 issue）

## 验证

- [x] `npm run typecheck` — 0 errors
- [x] `npm test` — 全部通过（新增 / 修改测试：`tests/unit/xxx.test.ts`）
- [ ] `npm run e2e:tmux` — [说明是否跑过；tmux 不可用时注明环境阻塞]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

### 推分支 + 创建 PR

```bash
# 检查 upstream
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

- 没 upstream → `git push -u origin $(git branch --show-current)`
- 有 upstream 且本地领先 → `git push`
- 同步了 → 跳过

**禁止**：`--force` / `--no-verify` 除非用户明确要求。

最后用 HEREDOC 创建：

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
<完整 body>
EOF
)"
```

成功后把 PR URL 抛给用户。

## 写作约定（强制，违反会被打回）

| 规则 | 反例 | 正例 |
|---|---|---|
| 标题：英文前缀 + 中文描述 | `feat: add mcp client` | `feat(mcp): MCP 客户端集成，支持 stdio 和 HTTP 传输` |
| 不写版本批次标识 | 「task07 新增」「本期重点」 | 直接说「新增 X」「改造 Y」——版本信息属 git history |
| 标识符保留英文 | 「权限检查器」 | `PermissionChecker` |
| Test plan checkbox 反映事实 | 全部 `[x]`（包括没跑过的） | 跑过 `[x]`，未跑 `[ ]` 必带说明 |
| scope 用项目实际子系统名 | `feat(backend)` | `feat(permissions)` |

## 不要做的事

- **不要假定默认分支名**：先 `gh repo view --json defaultBranchRef`
- **不要 `git add -A` / `git add .`**：`.agentcode/` 可能含 API key；按文件名加
- **不要漏 `Closes #X`**：issue 自动关联依赖这个语法
- **不要漏 `🤖 Generated with [Claude Code]` 标识**：保留在 body 末尾
- **不要把 commit message 直接堆成 body**：commit history 反映过程，PR body 反映结果
- **不要为了写得漂亮而虚构**：没跑的测试不要写在 `[x]` 里
- **不要跳过门 0**：没跑 simplify 直接进门 1 等同于跳过质量门禁
