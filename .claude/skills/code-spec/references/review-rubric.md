# 评审、版本与状态规则

在风险分级、文档评审、代码评审、批准记录或 reviewer 完整性校验前读取本文件。

## 风险分级

| 级别 | reviewer | 判定条件 |
|------|----------|----------|
| 低风险 | 1 | 单模块；不涉及安全、权限、敏感数据或生产配置；不改变公共契约；容易验证和回滚 |
| 高风险 | 3 | 跨模块；认证/授权/安全；数据迁移或持久化格式；公共 API/协议；生产配置；外部服务；重大架构；破坏性或难回滚变更 |
| 严格模式 | 3 | 用户明确要求三个 reviewer、严格模式或等价要求；覆盖原低风险判断 |

只要命中任一高风险条件就使用三个 reviewer。信息不足以可靠判断时先问一个问题；仍不确定则按高风险处理并记录原因。风险变化后重新分级。

## 文档评分表

四项必须全部给分，分项之和必须严格等于总分。

| 分项 | 分值 | 检查内容 |
|------|------|----------|
| 需求与上游一致性 | 30 | 用户目标是否完整；当前上游 hash 对应内容是否被准确继承 |
| 完整性 | 25 | 边界、异常、风险、回滚和必要交付是否齐全 |
| 可执行与可验证性 | 25 | 下一阶段能否无猜测执行；结论是否有明确验证方式 |
| 清晰度 | 20 | 是否无歧义、无矛盾、无占位符，结构是否易用 |

单个 reviewer 仅在以下条件全部成立时通过：

```text
total >= 80
AND component_sum == total
AND blockers.length == 0
```

所有要求数量的 reviewer 都必须分别通过。不得平均，不得四舍五入，不得用高分抵消低分或 blocker。

### 问题级别

- `blocker`：会造成安全绕过、数据损坏、关键需求错误、不可恢复操作，或使下一阶段无法可靠执行。
- `must_fix`：当前版本存在的明确缺陷，必须在评审证据中列出，但不阻止推进；可在下一阶段跟进处理。
- `suggestion`：不阻止批准的改进建议，说明收益但不得伪装成 blocker。

修改任何被评审内容后，旧评分自动失效。必须针对新 hash 重跑完整评分。

## 文档 reviewer 提示词

向每个 reviewer 提供相同文档、用户原始需求、当前文档 hash、全部上游路径与 hash，以及必要的只读项目上下文。使用以下约束：

```text
你是独立只读 reviewer。平台权限或工具白名单只允许读取；不得创建、修改、删除、格式化或生成文件，也不得运行改变工作区的命令。不要参考其他 reviewer 的结论。

检查文档是否满足用户需求以及给定上游 hash 对应的已批准内容。按 30/25/25/20 四项评分，逐项说明扣分。先列 blocker，再列 must_fix 和 suggestion。若存在任何 blocker，即使总分达到 80 也必须给出 FAIL。must_fix 必须列出但不影响 verdict。

输出字段：
- document_hash
- upstream_hashes
- component_scores: requirements_30, completeness_25, executable_25, clarity_20
- total
- blockers: []
- must_fix: []
- suggestions: []
- verdict: PASS | FAIL
- evidence
```

主代理必须独立校验分项合计和通过条件，不照抄 reviewer 的 `verdict`。

## 代码 reviewer 提示词

提供任务需求、当前完整 diff、任务文件 hash、变更集 hash、测试命令与实际结果：

```text
你是独立只读代码 reviewer。只允许读取，不得编辑或运行改变工作区的命令。审查当前 hash 对应的完整 diff，不要只看最后两行修改。

检查正确性与回归、仓库模式与可维护性、测试与错误处理、安全与权限风险。区分 blocker、must_fix、suggestion，并用路径和行号给出证据。存在 blocker 时 verdict 必须是 FAIL；must_fix 必须列出但不影响 verdict。

输出字段：
- task_hashes
- change_set_hash
- blockers: []
- must_fix: []
- suggestions: []
- verdict: PASS | FAIL
- evidence
```

代码审查通过要求当前 hash 一致，且所有 reviewer 的 `blockers` 均为空。`must_fix` 必须列出并记录，但不阻止通过。审查后发生任何修改时，验证与审查同时失效。

## 只读完整性校验

优先使用平台强制的只读 agent 或明确的读取工具白名单。平台无法强制只读时，禁止在共享工作树中运行 reviewer；`git status` 和局部文件 hash 无法覆盖范围外文件或已 dirty 文件的内容写入，不能作为权限隔离的替代。

可接受的 fallback 只有一次性隔离副本：

1. 先取得用户对创建隔离副本的批准，只复制 reviewer 所需的脱敏输入，不带 secret 或写回凭据。
2. 在副本内运行 reviewer，禁止副本连接 canonical workspace 的写路径。
3. 使用完整 manifest 对副本前后内容逐项校验；任一变化都作废本轮结果并丢弃副本。
4. 不把副本中的任何修改同步回 canonical workspace。

无法提供平台只读限制或上述隔离副本时，停止阶段推进并报告阻塞。任何检测到的意外变化都不得 reset、checkout、clean、revert 或自动修复。

## 版本与批准状态表

状态可以保存在当前任务的结构化进度记录中；不要把状态字段写入被 hash 的文档正文。每次评审、批准、失效和重新绑定都更新一行：

| artifact | document_hash | upstream_hashes | risk/reviewers | round | scores | blockers | must_fix | approval | status |
|----------|---------------|-----------------|----------------|-------|--------|----------|----------|----------|--------|
| spec.md | `[hash]` | `{}` | low/1 | 0 | `[score]` | `[]` | `[]` | `[用户原话或空]` | draft/reviewed/approved/invalid |
| plan.md | `[hash]` | `{spec: hash}` | high/3 | 1 | `[scores]` | `[]` | `[]` | `[用户原话或空]` | reviewed |

状态转换：

```text
draft -> reviewed -> approved
   |          |          |
   +----------+----------+-> invalid（当前内容或任一上游 hash 改变）
```

- `reviewed` 只表示当前 hash 通过门禁，不代表用户批准。
- `approved` 必须同时保存当前 hash、上游 hash 和用户明确批准原话。
- 上游 hash 改变时，把全部下游行无条件标为 `invalid`；下游文本未变也必须重新评审和批准。
- 每阶段最多自动返工两轮。达到上限后记录 reviewer 分歧、风险和选项，状态保持 `draft` 或 `invalid`，等待用户裁决。

## 任务版本与证据记录

每个实现任务记录：

| task | file_hashes | change_set_hash | failing_test | passing_test | review | risk_decision | status |
|------|-------------|-----------------|--------------|--------------|--------|---------------|--------|
| T1 | `{path: hash}` | `[hash]` | `[命令+失败摘要]` | `[命令+通过摘要]` | `[当前 hash 的结论]` | `[用户原话或空]` | active/complete/invalid |

`change_set_hash` 必须从仓库根目录运行 `node .claude/skills/code-spec/scripts/change-set-hash.mjs -- <任务目标路径...>` 生成。工具绑定 HEAD、porcelain v2 状态、tracked binary diff、untracked 路径/类型/模式/内容；不得用时间戳、人工摘要或仅 `git diff` 代替。

任何审查后修改都把 `passing_test` 和 `review` 标为失效。重新验证、重新审查当前完整 diff，并只对稳定且无 blocker 的当前 hash 标记完成。每个任务最多自动返工两轮，之后必须停止并让用户决定改变范围、返回文档阶段或终止。
