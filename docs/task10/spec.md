# 斜杠命令框架与运行时控制 Spec

## 背景

AgentCode 当前只在 `ChatSessionController` 内通过正则识别 `/compact`、`/plan`、`/do`，输入框在模型生成期间完全禁用。该实现缺少统一的命令注册、帮助、补全、运行中控制、会话内恢复入口，也把本地控制行为与 Agent 对话耦合在一起。

本功能面向使用 AgentCode TUI 的开发者。目标是建立一套确定、快速、可测试的命令框架：斜杠输入先于 Agent 路由，本地控制命令不消耗模型 Token，提示词/工作流命令只把展开后的有效任务送入 Agent。同时补齐会话、记忆、权限、状态、代码审查，以及 Codex 风格的 Queue、Steer、Stop 运行时控制。

## 目标

- 建立统一、声明式、启动时完成校验的命令注册与分发框架。
- 让常用本地操作绕过 Agent，响应快速、行为确定且不污染模型上下文。
- 在 TUI 中提供命令发现、帮助、两级补全、本地动态候选和明确错误反馈。
- 将 Agent 工作模式、权限模式、会话生命周期和 UI 呈现分离管理。
- 支持可恢复的新会话、会话内恢复、长期记忆查看/删除和权限规则热更新。
- 提供一次性的只读 Review Operation，以及运行中的 Steer、Queue、Stop 控制。

## 本阶段交付物

- 本阶段只创建并评审 `docs/task10/spec.md`、`plan.md`、`tasks.md`、`checklist.md` 四份规划文档。
- 本阶段不修改实现代码、测试、配置或生产文件。四份文档获批也不构成代码修改授权；实现前必须单独取得用户明确授权。

## 功能需求

### F1：输入路由与命令解析

- 所有用户提交先经过 App 级输入路由：去除首尾空白后以 `/` 开头的非空输入按命令处理；其他非空输入按普通用户消息处理；空输入直接返回，不产生事件。
- 命令名为第一个空白字符前的文本，解析时转为小写，大小写不敏感；参数原始大小写和内容保持不变。
- 解析器同时产生 `rawArguments` 和 quoted `argv`。命令声明 `none`、`raw` 或 `argv` 参数模式。
- `argv` 采用平台无关的固定规则，而不是 POSIX shell 或 Windows shell 的完整语法：空白仅在引号外分隔参数；单引号内所有字符均为字面量且反斜杠不转义；双引号内只允许 `\"`、`\\`、`\n`、`\r`、`\t`；引号外反斜杠只转义空白、单引号、双引号和反斜杠，其他 `\x` 视为保留反斜杠的两个字面字符。因此 Windows 路径可写为单引号包围的 `'C:\path\file'`，或在双引号中写成 `"C:\\path\\file"`。
- 未闭合引号、禁止的多余参数在 handler 执行前返回参数错误和权威 usage；不将普通 Windows 路径中的未知 `\x` 判为非法转义。
- 未命中的 slash 输入不得回退成普通用户消息或发送给模型。系统在高置信时显示最多 3 个非隐藏候选，并始终提示使用 `/help`；不得自动纠正或自动执行。
- 唯一前缀只用于补全，不允许直接执行，例如 `/sta` 按 Enter 仍为未知命令。

### F2：命令注册、元数据与冲突校验

- 命令注册中心管理以下元数据：canonical name、aliases、简短描述、分类、结构化 `usage[]`、带说明的 `examples[]`、参数提示、参数模式、执行机制、影响范围、默认运行中策略、隐藏状态、用户可调用状态、来源和可选 namespace。
- 执行机制区分 `local`、`prompt`、`hybrid`；影响范围独立声明 UI、session、mode、config、model 等副作用。类型只用于发现、预检和审计，不替代命令对象本身。
- Registry 支持按来源批量注册并在启动后 seal。首版只注册 built-in；保留 skill/plugin 来源和 namespace 数据结构，但不扫描或加载扩展命令。
- built-in canonical name 或 alias 大小写不敏感冲突时，Registry 抛出包含冲突名称和双方来源的 typed startup error；CLI 在渲染 TUI 前打印诊断并非零退出。框架本身不得调用 `process.exit()`。
- 未来扩展来源发生冲突时应能隔离该来源而非拖垮主程序；首版不实现扩展加载或隔离 UI。
- `hidden=true` 表示不出现在补全、帮助和未知命令建议中，但精确调用是否允许由独立的 `userInvocable` 决定。
- 元数据中的所有 examples 必须能通过该命令的真实参数 parser，防止帮助与行为漂移。

### F3：命令执行、动作与 App 状态

- 命令 handler 为纯逻辑：只读取不可变 App/session/permission/memory/run 快照，不执行磁盘、Git、网络、Provider 或 UI I/O。
- handler 返回 typed Command Result 和有序 Command Actions。动作至少覆盖：notice、command output、panel、modal/interaction、Agent mode 变更、prompt 提交、session 创建/激活/重命名、memory 删除、permission 更新、review 启动、steer、queue 和 stop。
- Dispatcher 分两阶段执行：先完成解析、目标存在性、运行中策略、能力、权限和所有可预检条件，再按序提交动作。预检失败时不得产生部分副作用。
- 提交阶段不承诺不可实现的通用回滚；发生外部失败时停止后续动作，准确显示已完成和未完成部分。
- 所有动作、Agent Loop 事件和交互结果最终转换为 typed App Event，由单一 App runtime 按序归并并发布统一快照；React 组件只订阅快照和发出意图，不直接协调跨模块状态。
- Command Error 与 Agent/Provider `lastError` 完全独立。用户拼写、参数或运行期错误不得把聊天 session 标记为 `needs attention`；详细 `/status` 可同时展示最近的两类错误。

### F4：命令发现、帮助、补全与快捷键

- 键入 `/` 时显示轻量命令补全。若用户在输入内容恰为 `/` 时按 Enter，则只打开/保持补全面板，不执行命令、不写历史、不清空输入；再次取消面板后输入仍为 `/`。单候选时 Tab 补全但不执行；多候选时显示菜单；候选可按 canonical name、alias、描述和参数提示过滤。
- 补全支持两级静态结构和本地动态候选：命令/alias、子命令/枚举、session ID/name、memory entry、permission scope/rule。首版不补全 Git branch、PR、文件路径或网络数据。
- alias 可被搜索，但补全结果规范化为 canonical name；hidden 命令不参与。
- `/help` 打开按分类组织、可搜索的完整命令面板；`/help <command-or-alias>` 显示 canonical name、aliases、描述、usage、examples、参数提示、执行机制、影响范围、运行中策略和是否调用 AI。
- Tab 专用于补全；Shift+Tab 在菜单中反向选择，无菜单时切换 DEFAULT/PLAN。帮助文本显示 `Enter send · Tab complete · Shift+Tab mode`，运行中还显示 Queue/Steer 快捷键。
- 运行中普通文本按 Enter 作为 Steer；Alt+Enter 作为 Queue。消息被接受后清空输入框；路由、投递或持久化失败时保留原输入。

### F5：内置命令与 aliases

首版提供以下 13 个 canonical 命令：

| 分类 | 命令 | aliases |
|------|------|---------|
| General | `/help` | `/commands` |
| Conversation | `/compact` | `/summarize` |
| Conversation | `/clear` | `/new` |
| Mode | `/plan` | 无 |
| Mode | `/do` | `/default` |
| Conversation | `/session` | `/sessions`, `/resume` |
| Workspace | `/memory` | `/memories` |
| Workspace | `/permission` | `/permissions` |
| Workspace | `/status` | 无 |
| Workflow | `/review` | 无 |
| Runtime | `/stop` | 无 |
| Runtime | `/steer` | 无 |
| Runtime | `/queue` | 无 |

- `/resume [id-or-name]` 是 `/session resume [id-or-name]` 的便利形式；裸 `/resume` 打开 session picker。
- `/new ["name"]` 与 `/clear ["name"]` 完全等价。
- `/default [text]` 与 `/do [text]` 完全等价。
- `/summarize [instructions]` 与 `/compact [instructions]` 完全等价。

### F6：Agent 模式、权限模式与临时 Review 状态

- 持久 Agent 模式仅有 `default | plan`，状态栏显示 `[DEFAULT]` 或 `[PLAN]`。现有内部 `full` 命名应迁移为 `default`，不保留重复概念。
- 权限模式仅有 `strict | normal | auto | yolo`，与 Agent 模式分离。
- Plan 始终应用只读安全策略；即使用户在 Plan 中选择 `auto` 或 `yolo`，当前有效权限仍为只读，退出 Plan 后才恢复所选权限模式。
- `/plan` 无参数只切换到 Plan，不调用模型；`/plan <text>` 切换到 Plan，并把余下原始文本作为新的用户任务提交。
- `/do` 无参数只切换到 Default，不调用模型；`/do <text>` 切换到 Default，并把余下原始文本作为新的用户任务提交。
- `/review` 运行期间显示临时 `[REVIEW]`。Review 不是第三个持久 Agent 模式；结束、失败或停止后恢复启动前的 DEFAULT/PLAN。

### F7：运行中策略、模式边界与输入消费

- 每条命令声明默认 `immediate | queue | reject` 策略，解析后的具体 operation 可覆盖默认值。Interaction 完成时必须再次应用同一 operation 级策略；active run、Agent mode、Review 状态或 session 发生变化时不得沿用打开 modal 时的旧判定。
- Plan/Review 的“只读”特指 **Agent 数据面只读**：模型和 ReviewRunner 不得通过工具修改 repo/workspace 文件、项目/全局配置、memory、permission 规则或其他外部状态。用户明确输入并确认的 AgentCode 控制面操作可以写 AgentCode 自有状态，但不能改变正在执行的 Agent operation 的只读上限，并必须产生 command audit event。
- 允许在 Plan/Review 和 active run 中执行的控制面写操作仅限：`session rename`、`memory delete`、`permission mode`、`permission remove`、`queue add/remove/clear`。其中 memory/permission/queue 删除需要确认；所有操作在确认后重新校验 operation 策略、session identity、目标 fingerprint 和模式上限。不得由模型、Steer 或 Review prompt 自动触发这些命令。
- 运行中 operation 矩阵如下，未列入的新增 operation 默认 `reject`：

| operation | active run | Plan/Review | Provider 调用 | 持久化 | 确认 |
|-----------|------------|-------------|---------------|--------|------|
| help、status、session current、memory status/show、permission status/rules、queue list | immediate | 允许 | 否 | 否 | 否 |
| session rename | immediate | 允许的控制面写入 | 否 | session metadata | 否 |
| memory delete | immediate 进入确认 | 允许的控制面写入 | 否 | memory index/file | 是 |
| permission mode | immediate；见 F13 权限升级规则 | 允许选择但不解除只读 | 否 | session state | 升级时是 |
| permission remove | immediate 进入确认 | 允许的控制面写入但不解除只读 | 否 | permission config | 是 |
| queue add/remove/clear | immediate；删除进入确认 | 允许的控制面写入 | 否 | session queue | remove/clear 是 |
| steer、stop | immediate | 允许；仍受模式上限 | 否 | run/session events | 否 |
| compact、clear、session resume、plan、do、review、queue run | reject | 按各命令空闲规则 | 依命令 | 依命令 | 否 |

- `queue` 策略保留在框架类型中；首版命令的延迟行为由持久 Queue 明确表达，不把任意命令静默排队。
- 本地命令、prompt/hybrid 命令和普通输入的成功/失败都必须返回“是否消费输入”，TUI 只在接受后清空。

### F8：命令历史、模型上下文与呈现

- 输入回溯历史、可见 command transcript、Provider context、持久 session state 四层分离。
- 除 `/clear` 外，成功或失败的命令输入可进入输入回溯；`/clear` 不进入回溯，避免新会话中误触重复创建。
- 命令及本地结果使用专门的 command activity/output 样式，不伪装成普通 user/assistant 对话。输入回溯保留用户原始 alias 文本；command transcript 显示 canonical command，并可附原始 alias 供审计。
- local 命令及其结果不得进入 Provider context。prompt/hybrid 命令只把展开后的有效任务送入模型，不发送 `/review`、`/plan` 等控制语法。
- Review 最终 findings/summary 以 typed review activity 持久化并展示，默认不自动进入后续主会话 Provider context。用户对 Review 结果的后续追问由 App 显式附带该 review activity 的稳定引用和必要结果文本，不附带 ReviewRunner 的中间工具上下文。
- 影响恢复的 session 名称、Agent mode、Permission mode 和 Queue 状态必须持久化；只读 panel 快照和瞬态 notice 不持久化。
- UI 呈现显式区分四类：带 TTL 的 notice、command output、可关闭 panel、带 request ID 的 modal/interaction。命令不得让 UI 根据文本长度猜测呈现方式。

### F9：`/compact [instructions]`

- 无参数时使用现有默认压缩策略；有参数时把完整 `rawArguments` 作为本次压缩的附加保留要求，不持久化为后续默认值。
- 参数不得改变安全边界，也不能恢复已被裁剪的内容。
- 压缩在当前 session 内完成；结果区分 compacted、emergency fallback、no history 和 failed，并使用 notice/command output 明确反馈。
- 运行中拒绝手动 compact；自动 compact 行为保持现有 ContextManager 策略。

### F10：`/clear ["name"]` 与活动会话生命周期

- `/clear` 创建空上下文的新 session，旧 session 保留并可恢复；它不是仅清屏，也不是原地清空 controller。
- 允许 0 或 1 个 name 参数：单词名称可不加引号，多词名称必须使用单引号或双引号组成单个 argv；两个及以上 argv 一律为参数错误。操作可恢复，因此不弹确认。
- 新 session 的 Agent mode 固定为 Default，Permission mode 沿用当前 App 选择，Queue 为空。
- 活动 session 由 App 级 workspace/coordinator 管理。新建或恢复时先完整构造候选 session/controller，成功后原子替换；失败时旧活动 session 不变。
- 每个活动 session 持有跨进程独占写锁。恢复当前 session 为 no-op；目标被其他活跃进程占用时拒绝且不提供强制接管。仅在 PID/创建时间校验确认 stale 后清理 stale lock。

### F11：`/session`

- 裸 `/session` 或 `/resume` 打开 session picker；支持按名称、ID、更新时间搜索，并标识当前、锁定、可恢复状态。
- `/session current` 显示当前 session ID、名称、创建/更新时间、turn 数、是否 resumed、Agent/Permission mode、Queue 数量和归档位置。
- `/session resume <id-or-name>` 或 `/resume <id-or-name>` 恢复指定 session。匹配顺序为：session ID 精确匹配；名称 Unicode 原文精确匹配；名称 Unicode case-fold 精确匹配。任一层命中多条即报告歧义并列出 ID/名称/更新时间，不做模糊自动选择；不存在、损坏或被锁定时明确失败，不切换当前 session。
- `/session rename <name>` 原子更新当前 session 名称和 picker 元数据；允许运行中执行，因为不改变活动 turn。
- 恢复 session 时恢复其持久 Agent/Permission 模式和 Queue；Queue 恢复后保持 paused，不自动执行。

### F12：`/memory`

- 裸 `/memory` 打开按 USER/PROJECT 分组的可搜索 memory picker。
- `/memory status` 显示自动笔记开关、两级条目数、索引和存储路径。
- `/memory show <scope> <entry>` 在 panel 中显示对应条目的 frontmatter、正文和文件路径；读取失败不把内容发送给模型。
- `/memory delete <scope> <entry>` 显示文件身份和不可恢复警告，用户确认后原子更新索引并物理删除正文文件；不得暗中保留回收副本。
- 删除前重新校验目标仍是索引中的同一文件且位于对应 memory root 内；目标在确认期间变化时拒绝删除。
- 首版不提供 memory add/edit、自动笔记开关热修改或通用 memory CRUD API。

### F13：`/permission`

- 裸 `/permission` 打开权限管理 panel。
- `/permission status` 显示当前选择的 Permission mode、当前有效模式、Plan 只读覆盖说明，以及 session/project/global 规则数量。
- `/permission mode <strict|normal|auto|yolo>` 修改当前 session 选择的模式；Plan/Review 中只记录待恢复模式，当前仍只读。相对当前有效模式扩大权限（例如 strict→normal/auto/yolo、normal→auto/yolo、auto→yolo）时必须显示确认，说明只影响尚未开始的工具 preflight，并写 command audit event；收紧权限可立即执行。
- `/permission rules [scope]` 按 session/project/global 分组展示规则及稳定的显示 ID。
- `/permission remove <scope> <rule-id>` 经确认后原子删除目标规则并重载权威权限快照。Permission service 不为整个 active run 冻结规则；每个尚未开始的工具调用都在执行前读取最新 generation 并重新 preflight。已开始的工具不追溯取消，已经生成但尚未执行的 tool call 也必须使用新 generation 重新判定。
- 权限模式/规则变化产生递增 generation 和 audit event，记录旧/新选择、有效只读上限、scope、目标 rule ID、active run ID 与时间。Plan/Review 的只读上限始终优先，权限升级不得使其当前或后续工具变为可写。
- 配置解析、写入或重载失败时保持旧文件和旧规则有效，不产生半写状态。
- 首版不允许通过命令手写新增 allow/deny 规则；持久新增规则仍只能来自真实工具审批流程。

### F14：`/status` 与状态栏

- 常驻状态栏保持简短：`[DEFAULT]`/`[PLAN]`/临时 `[REVIEW]`、运行状态、模型、估算上下文 Token；Queue 非空或暂停时显示 `queued: N` 和 paused 状态。
- `/status` 打开本地只读详细 panel，至少包含：runtime/mode/cwd/Git，provider/protocol/model/thinking，估算 Token/context window/占比/compaction，session 元数据，permission 模式与规则数，memory 开关与条目数，MCP configured/connected/failed，config 来源，以及最近 command/Agent error。
- `/status` 在运行中立即可用，不发模型请求。
- Git、MCP 等慢项使用有界超时并行刷新；失败显示 `unknown`/`unavailable`，不得阻塞 TUI。Token 必须标记为 estimated，不伪装成精确计数。

### F15：临时只读 `/review`

- 语法为：
  - `/review`：审查当前工作树相对 HEAD 的改动；
  - `/review branch <name> [--focus "text"]`：审查当前分支相对指定分支；
  - `/review pr <number|url> [--focus "text"]`：审查指定 PR；
  - `/review [--focus "text"]`：当前工作树并附加关注点。
- 显式 branch/PR target 在本地 preflight 中不存在、不可访问、未认证或网络失败时硬失败，不回退到当前工作树。错误分类至少区分 `auth_required`、`network_unavailable`、`rate_limited`、`target_not_found`、`repo_mismatch` 和 `target_changed`。
- Branch target：在当前 repo 内将指定 ref 解析并冻结为 base SHA，head 冻结为当前 HEAD SHA；目标 ref 不存在时失败。PR target 首版仅支持 GitHub：number 使用当前 repo 的 canonical GitHub owner/repo；URL 的 host 必须是 `github.com`，owner/repo 必须与当前 repo canonical identity 一致，否则 `repo_mismatch`。通过 `gh`/GitHub API 获取 PR base/head repo、base/head SHA；fork PR 允许 head repo 不同，但 diff 必须严格使用 API 返回的冻结 base/head SHA，不隐式 checkout 或 fetch 未验证 ref。
- Preflight 获取元数据和 diff 后记录 repo identity、base/head SHA、PR number/URL、diff hash、focus 和获取时间。ReviewRunner 启动前重新确认当前 repo identity 与冻结 target 未变；变化时 `target_changed` 硬失败。Review 过程只使用冻结 diff/文件快照，不因远端后续变化改变目标。
- Review 使用冻结目标，在与主对话隔离的只读 Review Operation 中运行；不得复用主会话 Provider context 或执行写工具。Review“只读”禁止 repo/workspace/config/memory/permission 等数据面写入；允许写入 AgentCode session archive 中的 typed review result 和运行审计事件。
- Review 结果写回当前 session，包含 target 摘要、结构化 findings 和简短 summary；中间工具输出不进入主 Provider context，最终结果默认也不自动进入后续主 Provider context，遵循 F8 的显式引用规则。
- finding 必须包含 severity、文件、可选行号、标题、具体失败场景和证据。只报告可能造成错误行为、数据损失、安全问题、测试失败或误导结果的问题；风格、命名和纯优化不算 finding。
- 允许 `findings: []`，此时明确“未发现符合报告阈值的问题”，不得为凑数制造建议。
- Review 运行中允许 Steer，但 Steer 不能解除只读限制。Review 完成后恢复启动前的 DEFAULT/PLAN。

### F16：Codex 风格 Steer

- 模型生成期间，普通文本按 Enter 或 `/steer <text>` 作为 Steer；空闲时 `/steer` 返回 `no_active_run`，不得退化成普通 prompt。
- Steer 成功接受后清空输入；若 active run 在接受时已结束或持久化失败，则保留输入，且不得自动转为 Queue。
- Steer 不强制中断当前模型请求或正在执行的工具；它进入 active run 的高优先级 guidance 队列，在下一次安全模型调用边界前按发送顺序注入。
- 多条尚未消费的 Steer 可合并为一个有顺序标记的 guidance block，但在可见 transcript 和 archive 中保留各自文本与时间。
- Steer 属于当前 turn，不增加 turn 计数；它进入 Provider context和会话归档，并以区别于普通 user turn 的样式显示。
- 工具审批等待期间可接受 Steer，但 Steer 不替代 allow/deny；审批解决后在下一安全边界注入。
- 一轮只触发一次自动笔记评估，输入包含初始用户任务和该轮全部 Steer。

### F17：持久 Queue

- 运行中 Alt+Enter 等价于 `/queue add <text>`，将文本作为未来独立 turn 加入当前 session 的 FIFO Queue；接受后清空输入。
- `/queue` 使用确定的子命令 grammar：
  - `/queue add <text>`：添加消息；
  - `/queue list`：显示序号、摘要、入队时间和冻结的 Agent mode；
  - `/queue run`：空闲时从队首开始 drain；
  - `/queue remove <index>`：确认后移除一条；
  - `/queue clear`：确认后清空全部。
- 所有 add 路径都先创建 Queue item 并原子持久化，再报告接受。空闲、Queue 为空且未暂停时，持久化成功后由同一 drain 机制立即将该 item 标记为 running 并开始普通独立 turn；不得绕过 Queue 直接提交。若持久化成功但启动 turn 失败，item 保留并 paused，输入视为已接受并通过 command output 说明失败；持久化失败则输入不清空。
- 当前 turn 正常完成后自动按 FIFO 连续消费至 Queue 为空。失败、停止、异常中止或恢复 session 后，剩余 Queue 保留并 paused；`/queue run` 恢复自动 drain。
- Queue 正在 drain 或 active run 存在时，用户新的普通输入遵循运行中键位：Enter 作为 Steer，Alt+Enter 追加 Queue。两个 turn 之间的调度间隙仍视为 drain active，普通 Enter 不得插队成为新 turn；只有 Queue paused 或为空且无 active run 时，普通 Enter 才启动新的直接 turn。
- Queue 严格 session-scoped 并持久化，不随 `/clear` 或 `/session resume` 迁移。每个 item 保存原始文本、入队时间和入队时 Agent mode；执行时使用 item 的 Agent mode和 session 当前 Permission mode，Plan item 仍强制只读。
- Queue 的持久化与状态变更必须先成功再报告接受；失败时输入不清空。

### F18：`/stop`

- `/stop` 只在 active run 存在时有效；空闲时返回 `no_active_run`。
- Stop 取消当前模型请求，并通过现有取消信号尽力停止尚未完成的工具；已完成或不可撤销的外部副作用不回滚，必须如实显示。
- 若 active run 正等待工具权限审批，Stop 同时将该 run 的所有待决审批 request 标记为 expired 并关闭对应 modal；晚到的审批响应按 request ID 安全忽略，不得恢复工具执行。
- 当前 turn 以 stopped 状态结束并归档；未消费 Queue 保留但 paused，不自动开始下一条。
- Stop 后状态栏显示 paused 和 Queue 数量；用户通过 `/queue run` 恢复 Queue，或继续提交新的普通任务。

### F19：Typed 多步交互

- Session picker、memory 删除确认、permission 规则删除确认、Queue remove/clear 确认等多步操作由统一 typed Interaction Coordinator 管理。
- 命令只返回 open/request action，不持有 UI 闭包或 React state。Coordinator 为请求生成 ID，确保同一请求最多结算一次。
- 用户选择或确认后必须重新校验目标、operation 级运行中策略、Agent/Review 模式上限、session identity 和文件 fingerprint；过期请求、目标变化、重复响应或 session 已切换时安全拒绝。
- 每个有副作用的 Command Action 和 Interaction settlement 携带唯一 idempotency key；App runtime 对已提交 key 返回既有结果，不重复写入或删除。
- 工具权限审批可复用协调机制的生命周期模式，但保留独立的业务 request/response 类型，不退化成无类型 yes/no。

## 非功能需求

- N1：性能。静态命令解析、registry 查询和一级补全不得执行 I/O；常规按键交互不产生可感知阻塞。动态候选和状态刷新必须支持取消与超时。
- N2：安全。local 命令文本、命令输出、权限规则、memory 内容和状态面板不得意外进入 Provider context。Review 必须强制只读，Plan 必须强制只读，且两者不能被 yolo/auto 或 Steer 绕过。
- N3：持久化可靠性。session 激活、Queue、名称、模式、memory 删除、permission 规则修改必须使用原子或可验证的写入流程；写入失败不得报告成功。
- N4：并发安全。活动 session 跨进程独占写入；所有确认操作防止 TOCTOU；Interaction request 只结算一次。
- N5：可测试性。parser、registry、handler、preflight、action/event 映射均可在无 Ink、无网络、无真实 Provider 的条件下测试；所有示例和 aliases 有自动验证。
- N6：可观察性。用户始终能区分 normal turn、Steer、queued item、command output、Review 和 stopped/failed 状态；不得静默丢弃输入、命令、Queue 或错误。
- N7：兼容性。现有 task09 会话消息仍可恢复；新增 session state/Queue 元数据不要求重写旧消息行。缺失新元数据时使用明确默认值，而不是保留旧 controller 架构。
- N8：平台一致性。Windows 与 POSIX 上的 parser、快捷键、锁、路径边界和原子写语义一致；平台不支持的锁/文件能力须明确失败或使用等价安全实现，不静默降级成无锁写入。
- N9：文档一致性。`/help`、补全、usage error 和测试均来自同一 sealed registry 快照。
- N10：范围控制。实现不得引入与本功能无关的插件、Skill 加载或通用 subagent 系统。

## 不做的事

- 用户自定义命令、动态 prompt 命令、插件命令加载和热重载。
- Skill 系统及 legacy command 兼容层。
- 命令级权限策略；本轮只管理已有工具权限模式和规则。
- Git branch、PR、文件路径或网络对象的 Tab 补全。
- Memory add/edit、回收站、版本历史或自动笔记开关热修改。
- 通用 subagent 框架；Review 只实现专用隔离运行器。
- Queue 跨 session 迁移、全局队列或远程同步。
- 自动纠正并执行未知命令。
- 将 `/clear` 实现为仅清屏。
- Commit、push 或 PR 发布。

## 边界与异常

- 输入为空或仅空白：不产生任何状态变化。
- 输入为 `/`：打开补全，不执行命令。
- 未知/隐藏/不可调用命令：分别返回明确错误；hidden 不出现在建议中。
- alias 与 canonical 大小写混用：解析到同一 canonical command，历史和补全显示 canonical 形式。
- 命令参数包含引号或转义：按统一 argv 规则处理；未闭合引号保留输入并显示位置明确的错误。
- 多动作命令 preflight 失败：不得先切模式、先删文件或先替换 session。
- active run 在 Steer 接受时刚结束：Steer 失败并保留输入，不自动转 Queue。
- Queue 持久化失败：消息不入队，输入不清空。
- Stop 时工具已经完成外部副作用：不声称回滚，显示实际结果。
- 恢复同一 session：返回 already active notice，不重建 controller。
- 恢复目标被其他进程占用：拒绝，不删除有效锁，不提供强制接管。
- Session 候选构造失败：继续使用原活动 session。
- Memory/permission 确认期间目标变化：拒绝操作并要求刷新。
- 显式 Review branch/PR 不存在或不可访问：硬失败，不回退工作树。
- Review 无 findings：正常成功，输出空 findings 说明。
- `/status` 某个探针超时：其他分区仍显示，超时项标为 unknown。
- 恢复旧 session 缺少名称、模式或 Queue 元数据：使用未命名、Default、配置/安全默认 Permission、空且 paused=false 的明确默认值；仅在下一次真实状态变更时写入新元数据，不因只读恢复而重写旧归档。
- Session lock 至少记录 session ID、owner PID、进程启动标识、创建时间和随机 nonce。只有能确认 PID 不存在，或同 PID 的进程启动标识不匹配时才视为 stale；平台无法可靠验证时拒绝自动清理并提示人工处理，不得以锁文件年龄单独判 stale。

## 验收标准

- AC1（对应 F1）：parser 单元测试覆盖空输入、单独 `/` Enter 不消费、大小写、rawArguments、quoted argv、固定转义规则、Windows 路径、未闭合引号、未知命令和前缀；断言未知 slash 从未调用 Provider，错误包含 `/help` 和保守候选。
- AC2（对应 F2）：注册全部 built-in 后 seal 成功；构造 canonical/alias 大小写冲突时在渲染前得到 typed fatal error，错误同时标识冲突双方；hidden/userInvocable 和 source/namespace 行为有单元测试。
- AC3（对应 F3）：纯 handler 测试只需传入 snapshot 即得到确定 Action；多动作命令任一 preflight 条件失败时 Action executor 记录零提交；App Event 顺序测试证明 React 外部只有一个权威快照。
- AC4（对应 F4+F5）：TUI 测试输入 `/` 可见 13 个 canonical 命令和指定 aliases；Tab 只补全不执行；动态 session/memory/permission 候选可选择；hidden 不出现；`/help` 和 `/help review` 展示元数据；Shift+Tab 无菜单时切模式。
- AC5（对应 F6）：`/plan`、`/do` 无参数不调用 Provider；带文本时先通过完整 preflight，再切模式并只提交余下文本；Plan 中选择 yolo 后有效策略仍只读，`/do` 后恢复 yolo；Review 期间显示 `[REVIEW]` 并在结束后恢复原模式。
- AC6（对应 F7+F8）：运行中及 Plan/Review operation 矩阵逐项测试；控制面写入均由用户显式触发并产生 audit event，不能解除 Agent 数据面只读；Interaction 确认后二次应用同一策略；被拒绝输入保留；local 命令不进入 Provider context；prompt/hybrid 只发送展开任务；Review result 默认不进入后续主 Provider context；command error 不覆盖 Agent `lastError`；notice/output/panel/modal 四类呈现可区分。
- AC7（对应 F9）：`/compact` 无参数沿用默认摘要；带 instructions 时摘要请求包含且仅本次包含该要求；no history、成功、emergency fallback、失败四条路径有可观察结果；运行中手动 compact 被拒绝。
- AC8（对应 F10+F11）：`/clear "新任务"` 创建命名、Default、沿用当前 Permission、空 Queue 的新 session，旧 session 可在 picker 恢复；候选构造失败不切换；current/resume/rename 和 `/resume` 便利形式通过集成测试；同 session no-op、有效锁拒绝、stale lock 清理均有测试。
- AC9（对应 F12）：临时 USER/PROJECT memory 中，status/show 正确；delete 确认后索引和正文同时消失；取消、目标变化、越界/链接路径和原子写失败均不删除错误文件且不报告成功。
- AC10（对应 F13）：permission panel/status/mode/rules/remove 可用；Plan/Review 覆盖正确；运行中权限扩大要求确认并写 audit；每个尚未开始（包括已生成但未执行）的 tool call 使用最新 generation 重新 preflight，已开始调用不受追溯；写入/解析失败保留旧规则。
- AC11（对应 F14）：状态栏在 Default、Plan、Review、generating、paused、Queue 非空时显示正确；`/status` 在运行中不调用 Provider并展示所有分区；Git/MCP 探针超时只使对应项 unknown；Token 明确标为 estimated。
- AC12（对应 F15）：ReviewRunner 对 worktree/branch/GitHub PR/focus 解析、repo identity、fork PR base/head SHA 和 diff hash 冻结有测试；auth/network/rate-limit/not-found/repo-mismatch/target-changed 分类正确且显式目标失败不启动 Provider；运行期间写工具不可用；结果只写 typed review activity 和 session archive、默认不进入后续主 Provider context；零 findings 正常成功；Review Steer 不解除只读。
- AC13（对应 F16）：运行中 Enter 和 `/steer` 在下一安全模型边界注入，不新建 turn；空闲 steer、结束竞态和持久化失败不消费输入；多条顺序保留；审批等待路径不绕过审批；archive 和 TUI 能区分 Steer。
- AC14（对应 F17）：Alt+Enter 与 `/queue add` 等价；所有 add 均先持久化再由统一 drain 启动；list/run/remove/clear grammar 无歧义；Queue 按 session 持久化并冻结 Agent mode；正常完成自动 FIFO drain，调度间隙普通输入不插队，失败/停止/恢复后 paused；持久化失败保留输入，持久化后启动失败保留 paused item；切 session 不迁移 Queue；进程重启后 Queue 可恢复且不自动运行。
- AC15（对应 F18）：运行中 `/stop` 取消模型并向工具传播取消，turn 归档为 stopped；已完成副作用不被报告为回滚；等待中的权限 request 被标记 expired，晚到响应不恢复执行；Queue 保留 paused；空闲 stop 返回 `no_active_run`。
- AC16（对应 F19）：picker/confirm 请求有 typed ID，重复响应、过期响应、session 切换、模式/运行策略变化和目标变化均只结算一次或安全拒绝；重复 idempotency key 不重复写入/删除；工具权限审批的既有行为不回归。
- AC17（对应 N1+N5+N9）：registry/parser/handler 测试不需要真实 Provider 或 Ink；静态补全不执行 I/O；所有 usage/examples 自动通过真实 parser；帮助、补全和错误引用同一 sealed registry。
- AC18（对应 N2+N3+N4+N8）：安全测试证明 local 数据不泄露到 Provider、Plan/Review 只读不可绕过、session lock 防并发写、memory/permission 操作防 TOCTOU，Windows/POSIX 路径与锁策略均有覆盖或明确平台验证证据。
- AC19（端到端）：在真实 TUI 中完成以下流程：普通任务运行时 Enter Steer、Alt+Enter Queue、`/status` 即时打开、`/stop` 后 Queue paused、`/queue run` 恢复；随后 `/review` 得到只读结构化结果，`/clear "next"` 创建新 session，并通过 `/session` 恢复旧 session 及其 paused Queue。
- AC20（重启恢复）：将至少两条消息持久化到 Queue 后终止并重新启动 AgentCode，恢复原 session，断言 Queue 内容、顺序、冻结 Agent mode 与 paused 状态保持，且用户显式 `/queue run` 前不发生 Provider 请求。
- AC21（文档阶段边界）：本阶段 Git diff 仅包含 `docs/task10/spec.md`、`plan.md`、`tasks.md`、`checklist.md`；不存在实现代码、测试或配置改动，代码实现授权单独记录。
