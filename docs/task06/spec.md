# 工具权限系统 Spec

## 背景

AgentCode 当前已有基础安全措施：workspace 路径边界限制文件操作在项目目录内，plan 模式通过 `filterByRisk` 过滤掉 write/execute 工具，超时和输出截断防止资源滥用。但缺少完整的权限控制——所有工具调用只要通过路径校验就直接执行，用户无法按操作类型或参数模式细粒度控制哪些操作可以自动执行、哪些需要确认、哪些应该直接拒绝。

工具系统已预留 `permission_denied` 错误码和 `ToolRisk` 类型（read/write/execute），为权限层提供了集成基础。

## 目标

为 AgentCode 实现五层防御的工具权限系统：

- 不可绕过的危险操作黑名单
- 符号链接感知的路径沙箱
- 支持 glob 匹配的可配置规则引擎
- 五档权限模式覆盖不同信任等级
- 阻塞式 TUI 弹窗实现人在回路确认

权限拒绝时返回结构化错误，不终止 Agent Loop，让模型有机会调整策略。

实现量说明：F2 路径沙箱复用现有 workspace.ts，零新增逻辑；F4 plan 模式复用 filterByRisk，零新增逻辑；F6 复用已有 permission_denied 错误码。新增实现集中在 F1（黑名单正则）、F3（规则引擎）、F5（TUI 弹窗）和 F7（管道编排）。

## 功能需求

### F1：危险操作黑名单

内置一组不可配置、不可绕过的正则规则，在工具执行前拦截已知高危命令。匹配到黑名单的调用直接返回 `permission_denied`，任何模式下都不可放行。黑名单仅对 run_command 工具生效，用于拦截破坏性 shell 命令。

初始黑名单（穷举，硬编码在源码中，后续版本可扩展）：
- 递归删除根目录的直接写法（`rm -r /`、`rm -rf /*`、`rm --recursive /`、`sudo rm -R /`）
- `chmod 777` 对系统目录
- fork bomb `:(){ :|:& };:`
- `mkfs` 格式化命令
- `dd if=/dev/zero of=/dev/sda` 及其变体
- `> /dev/sda` 直接写磁盘设备
- `curl|bash`、`wget|sh` 等管道远程执行

### F2：路径沙箱

所有文件类工具（read_file、write_file、edit_file、glob_files、search_code）的路径参数在权限检查阶段验证是否落在项目目录内。先解析符号链接到真实路径，再做前缀判断，防止符号链接逃逸。

现有 workspace.ts 已实现此逻辑（符号链接解析、前缀判断、错误返回），本需求将其纳入权限系统统一管理，不重复实现。

### F3：可配置规则引擎

支持用户通过 YAML 文件声明权限规则。规则按三层优先级加载：

- 会话级（内存）— 通过 TUI 弹窗"本会话允许"选项生成，进程结束后丢失
- 项目级（`.agentcode/permissions.yaml`）
- 用户全局级（`~/.agentcode/permissions.yaml`）

高优先级层命中后，低优先级不再判断。同一层内按声明顺序从上到下匹配，第一条命中的规则生效（first-match-wins）。

规则格式为「工具名(模式)」+ allow/deny。YAML 示例：

```yaml
rules:
  - rule: "run_command(git *)"
    action: allow
  - rule: "write_file(*.env)"
    action: deny
  - rule: "read_file(src/**)"
    action: allow
```

Pattern 匹配目标（规则的模式部分匹配工具调用的哪个参数）：
- run_command：匹配 command 参数的完整命令字符串
- 文件类工具（read_file、write_file、edit_file）：匹配 path 参数的相对路径
- glob_files：匹配 pattern 参数
- search_code：匹配 path 参数（搜索目录）

glob 匹配语义：`*` 匹配不含路径分隔符的任意字符序列，`?` 匹配单个非分隔符字符，`**` 匹配跨路径分隔符的任意层级。字面量中的 glob 元字符用反斜杠转义（如 `\*` 匹配字面星号）。

### F4：五档权限模式

提供 plan、strict、normal、auto、yolo 五种模式，控制规则未命中时的默认行为：

| 模式 | 未命中时行为 | 说明 |
|------|-------------|------|
| plan | read 工具可用，write/execute 不可用 | provider 侧 filterByRisk + checker 纵深拒绝 |
| strict | 直接拒绝 | 只有显式 allow 规则命中的操作才能执行 |
| normal（默认） | 弹窗确认 | 日常开发模式 |
| auto | 内置安全规则判断 | 已知安全自动放行，不确定弹窗 |
| yolo | 自动允许 | 完全信任，快速迭代 |

权限模式通过项目配置文件 `.agentcode/config.yaml` 的 `permission_mode` 字段设置，默认值为 `normal`。运行时通过 Tab、`/plan`、`/do` 同步切换 AgentLoop 模式和 PermissionChecker 策略；从 plan 返回 full 时恢复配置的 strict/normal/auto/yolo 策略，初始配置为 plan 时使用 normal 作为 full fallback。

auto 模式内置安全规则（硬编码白名单，与黑名单互补——黑名单是"已知危险必须拦"，安全白名单是"已知安全可放行"）：

- read 工具（read_file、glob_files、search_code）：全部自动放行
- write/edit 工具：目标路径匹配 `src/**`、`tests/**`、`docs/**` 时放行
- run_command 白名单（前缀匹配，即 `git log --oneline` 匹配 `git log`）：
  - `git status`、`git diff`、`git log`、`git branch`
  - `npm test`、`npm run build`、`npm run typecheck`
  - `npx tsc --noEmit`、`npx vitest`

auto 模式白名单不可由用户配置扩展；用户需要放行更多命令时，应通过 F3 规则引擎添加 allow 规则。

### F5：人在回路确认

当权限判定结果为"需要确认"时，以阻塞式 TUI 弹窗呈现工具调用摘要，Agent Loop 暂停等待用户选择后才继续执行。并发请求通过 FIFO 协调器串行展示，每个请求成为活动项后开始 30 秒超时。

弹窗展示内容：
- 工具名称
- 关键参数摘要（run_command 显示命令内容，文件工具显示目标路径）
- 工具的 risk 类型（read/write/execute，来自工具定义的 ToolRisk 字段）

用户选项：
- **允许（仅本次）**：只允许当前这一次调用执行
- **允许（本会话）**：生成会话级 allow 规则，本次会话内匹配该模式的调用不再弹窗；会话结束后规则消失
- **允许（永久）**：将对应 allow 规则追加写入项目级 `.agentcode/permissions.yaml`
- **拒绝**：返回 `permission_denied` 错误结果，行为与 F6 一致

### F6：权限拒绝不终止 Agent Loop

工具因权限被拒时返回 `permission_denied` 错误结果（含拒绝原因和来源层，如"blacklist"、"rule: deny"、"user denied"、"strict mode: not explicitly allowed"），Agent Loop 将该结果作为工具输出反馈给模型，模型可根据错误信息调整策略（换命令、换路径、告知用户）。

### F7：权限判定管道

五层按固定顺序执行，任一层产出明确结果（allow/deny/ask）后跳过后续层：

1. **黑名单** — 仅 run_command 工具，命中则 deny
2. **路径沙箱** — 仅文件类工具，路径越界则 deny
3. **规则引擎** — 按优先级查三层规则，命中 allow/deny 则返回对应结果
4. **内置安全规则** — 仅 auto 模式生效，命中则 allow
5. **模式默认行为** — strict→deny，normal→ask，auto→ask，yolo→allow

plan 模式先在工具注册阶段通过 filterByRisk 隐藏 write/execute；保留下来的 read 调用仍经过黑名单、路径沙箱和显式 deny 规则，未命中时默认放行。checker 对直接到达的 write/execute 调用做不可被 allow 规则绕过的纵深拒绝。

## 非功能需求

- **N1：性能** — 权限判定管道（不含人在回路等待）的开销不超过 5ms。规则文件在会话启动时一次性加载到内存，glob matcher 在加载或新增规则时编译一次，运行时不重复编译。
- **N2：确定性** — 相同的工具调用、相同的规则集、相同的权限模式，必须产出相同的判定结果。不依赖随机数、时间戳或外部状态。
- **N3：可测试性** — 权限判定逻辑与 TUI 解耦，确认交互通过外部注入的回调提供，核心判定管道可在纯单元测试中验证，无需终端环境。
- **N4：渐进式集成** — 权限系统作为独立模块插入现有 `executeToolCall` 流程，不修改已有工具的 `validate()` 和 `execute()` 实现。现有测试不因权限模块的引入而失败。新增工具自动受权限系统管辖，无需额外注册。
- **N5：配置容错** — 规则文件不存在时静默使用空规则集。规则文件存在但格式错误时，启动时输出包含错误位置的警告信息，跳过整个格式错误的文件回退到空规则集，不阻塞启动。
- **N6：安全性** — 黑名单规则硬编码在源码中，不可通过配置文件或运行时参数覆盖。路径沙箱必须处理符号链接、`..` 遍历、大小写（Windows 平台）和 junction points（策略：解析到真实路径后做前缀判断，真实路径越界则拒绝）。

## 不做的事

- 不做网络请求限制 — 留给后续章节
- 不做资源配额 — 现有 timeout 和 maxOutputBytes 保持不变，不纳入权限系统
- 不做审计日志 — 不记录权限判定历史到文件或数据库
- 不做规则编辑 UI — 规则文件由用户手动编辑 YAML
- 不做远程规则同步 — 规则只存在本地文件系统
- 不做工具级动态注册/注销 — 权限系统通过拦截执行来控制，不从 registry 中移除工具定义
- plan 模式复用现有 filterByRisk 做声明过滤，同时由权限系统保留执行期纵深拒绝
- 会话级规则存储在内存中，进程崩溃或中断后丢失，不做持久化恢复
- auto 模式白名单不可由用户配置扩展（需要更多放行用 F3 规则）

## 验收标准

- **AC1：黑名单拦截** — 在任何权限模式下（包括 yolo），对 run_command 工具传入 `rm -rf /` 命令，返回 `permission_denied` 错误，错误信息包含"blacklist"字样，工具不被执行，Agent Loop 收到错误后继续运行。

- **AC2：路径沙箱防逃逸** — 创建一个符号链接指向项目目录外部（如 `/etc/passwd`），对 read_file 工具传入该符号链接路径，返回拒绝结果。使用 `../../etc/passwd` 形式的路径同样被拒绝。

- **AC3：规则匹配生效** — 在项目级 permissions.yaml 中配置 `run_command(git *)` 为 allow，在 normal 模式下执行 `git status`，不弹窗直接放行。配置 `write_file(*.env)` 为 deny，写入 `.env` 文件时直接返回 `permission_denied`，不弹窗。

- **AC4：三层规则优先级** — 用户全局级配置 `run_command(npm *)` 为 allow，项目级配置 `run_command(npm publish)` 为 deny：执行 `npm publish` 被拒绝（项目级优先）。再在会话级添加 `run_command(npm publish)` 为 allow：执行 `npm publish` 被允许（会话级优先）。

- **AC5：五档模式行为** — 对一个未被任何规则命中的工具调用：
  - plan 模式：read 工具可用且仍受 sandbox/显式 deny 约束；write/execute 不出现在模型可用工具列表中，直接调用也被拒绝
  - strict 模式：返回 `permission_denied`，错误信息包含"not explicitly allowed"
  - normal 模式：弹出 TUI 确认弹窗，等待用户选择后才继续
  - auto 模式：read_file 调用自动放行不弹窗；对未在安全白名单中的 shell 命令（如 `curl http://example.com`）弹窗确认
  - yolo 模式：自动放行，不弹窗

- **AC6：弹窗三种放行粒度** —
  - 选择"仅本次"后当前调用执行成功，立即再发起相同工具+相同模式的调用，仍弹窗
  - 选择"本会话"后当前调用执行成功，再发起匹配同一模式的调用不弹窗；重启会话后发起同一调用，恢复弹窗
  - 选择"永久"后当前调用执行成功，项目级 `.agentcode/permissions.yaml` 中新增对应 allow 规则；新会话中该操作自动放行

- **AC7：权限拒绝不终止循环** — 工具因权限被拒后，Agent Loop 的下一轮迭代中模型收到包含 `permission_denied` 错误码和拒绝原因的工具结果，模型可以发起新的工具调用继续工作。

- **AC8：配置容错** — 删除 permissions.yaml 后启动会话，正常运行使用空规则集。在 permissions.yaml 中写入非法 YAML 语法后启动会话，输出包含错误位置的警告信息，回退到空规则集正常运行。

- **AC9：现有功能不退化** — 权限系统集成后，运行 `npm run typecheck` 和 `npm test` 全部通过，现有工具的 validate/execute 逻辑未被修改。
