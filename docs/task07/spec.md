# MCP 客户端集成 Spec

## 背景

AgentCode 当前内置六个工具（read_file、write_file、edit_file、run_command、glob_files、search_code），所有工具静态编译在代码中，扩展新工具需修改源码并重新发布。

Model Context Protocol（MCP）是 Anthropic 主导的开放标准，定义了 AI 系统与外部工具服务交互的协议层：本地进程通过 stdio 管道、远端服务通过 HTTP 端点，双方用 JSON-RPC 2.0 通信。通过实现 MCP 客户端，AgentCode 可以在运行时发现并接入任意符合 MCP 规范的外部工具，无需修改代码。

当前配置系统已支持项目级和用户级两层配置文件，MCP Server 列表将作为新字段加入配置，沿用同样的双层结构但采用合并语义（而非当前主配置的"互斥选一"语义）。

## 目标

- 让用户通过配置文件声明 MCP Server 列表，无需改代码即可扩展 AgentCode 的工具能力
- 通过标准 MCP 协议连接外部服务，支持 stdio（本地子进程）和 Streamable HTTP 两种传输
- 外部 MCP 工具对 Agent 完全透明——Agent 使用 mcp_search_tools 搜索后调用 MCP 工具，与调用内置工具的方式一致

## 功能需求

**F1：MCP 配置声明**
用户在配置文件中通过 `mcp_servers` 字段声明 Server 列表。每个 Server 是一个具名条目（key 为 Server 名），支持两种类型：
- stdio 类型：声明要启动的本地子进程命令、参数列表、以及可选的环境变量（值支持 `${VAR}` 展开为宿主进程的环境变量）
- http 类型：声明远端服务的 URL 和可选 HTTP 请求头（值同样支持 `${VAR}` 展开）

**F2：双层配置合并**
`mcp_servers` 支持用户级（`~/.agentcode/config.yaml`）和项目级（`.agentcode/config.yaml`）两层配置。两层按 key 合并，项目级条目覆盖同名用户级条目，不同名的条目来自两层各自保留。这与主配置字段当前"互斥选一"的行为不同，是 MCP 专属的合并语义。

**F3：MCP 会话握手**
AgentCode 启动时，对每个声明的 MCP Server：
1. 建立传输连接（stdio 时启动子进程、建立双向管道；HTTP 时准备好请求目标）
2. 发送 `initialize` 请求，完成 MCP 协议握手，协商协议版本和能力
3. 握手成功后发送 `initialized` 通知（单向通知，无需等待 Server 响应）

**F4：工具发现**
握手完成后，向 Server 发送 `tools/list` 请求，获取该 Server 提供的工具列表（含名称、描述、输入 schema）。

**F5：工具适配与注册**
将发现到的远端工具包装成 AgentCode 已有的工具接口，注册进工具中心。Agent 调用时感知不到工具来源差异，完全透明。MCP 工具名以 Server 名作为命名空间前缀（如 `myserver__tool_name`），避免与内置工具名冲突。

**F6：工具调用代理**
Agent 请求调用某个 MCP 工具时，适配层向对应 Server 发送 `tools/call` 请求，等待响应，将结果按以下规则映射为统一格式返回给 Agent：
- MCP 响应中 content 数组的 text 类型条目拼接为结果文本
- image 和 resource 类型条目以描述性占位文本表示（如 `[image]`、`[resource]`）
- MCP 响应的 `isError` 为 true 时，以工具错误格式返回，错误类型为内部错误

调用过程遵守工具执行上下文中的取消信号和超时时限约束。

**F7：连接生命周期管理**
每个 MCP Server 的连接在 AgentCode 整个运行期间保持存活，会话结束时统一关闭（stdio 子进程正常退出）。单个 Server 连接失败或调用出错时，只影响该 Server 的工具，不影响其他 Server 和内置工具。单次工具调用失败以工具层错误返回，不向上抛出。连接失败时在用户可见的界面记录警告信息，不阻止 AgentCode 整体启动。

**F8：JSON-RPC 2.0 消息层**
所有 MCP 通信使用 JSON-RPC 2.0：请求携带唯一 id（整数或字符串），响应按 id 与请求配对，支持请求/响应、通知（无 id）两种消息类型。

**F9：stdio 子进程环境隔离**
启动 stdio 类型 MCP Server 的子进程时，不继承宿主进程的完整环境变量。子进程只获得：
- 宿主进程的 `PATH`（保证可执行文件查找正常）
- Server 配置中显式声明的 `env` 键值对（支持 `${VAR}` 展开后的值）

宿主进程中的 API key、token、凭证等其他环境变量不传入子进程，防止泄露给外部命令。

**F10：MCP 工具懒加载**
MCP 工具不在 system prompt 中预展开，不随内置工具一起注册进 Agent 的工具上下文。取而代之，注册一个内置的 `mcp_search_tools` 工具，Agent 通过它搜索匹配的 MCP 工具。

搜索采用关键词匹配：对工具名称和描述文本做大小写不敏感的子字符串匹配，支持中英文关键词。匹配时将查询词按空白字符拆分为词列表，任一词命中即纳入结果。无匹配时返回空列表，不报错。搜索结果返回匹配工具的名称、描述和输入 schema，Agent 再按需发起调用。

**F11：MCP 工具按需调用**
`mcp_search_tools` 返回匹配结果后，Agent 直接用工具名调用对应 MCP 工具（格式 `{serverName}__{toolName}`），执行路径与内置工具一致——走同一套工具执行流程，受同一套权限检查约束。MCP 工具在工具注册表中始终存在（可被工具注册表按名称查找到），只是不出现在对外暴露给 Provider 的工具声明列表里。

**F12：MCP 工具 risk 推断**
将 MCP 工具注册时，根据工具名称和描述文本自动推断 risk 级别，支持中英文关键词，大小写不敏感：
- read：包含读取、查询、列出、搜索、获取、read、get、list、search、query、fetch 等语义词
- write：包含写入、创建、更新、删除、修改、write、create、update、delete、modify、remove、set 等语义词
- execute：无法判断或包含执行、运行、execute、run、invoke、call 等语义词（保守兜底）

推断逻辑参考现有权限系统中的自动安全评估策略，保持 risk 语义一致。用户无法在配置中手动覆盖单个工具的 risk（留给后续任务）。

## 非功能需求

**N1：隔离性**
单个 MCP Server 的连接失败、握手失败或工具调用异常，只影响该 Server 的工具不可用，不影响其他 Server 和所有内置工具的正常运行。

**N2：环境变量安全**
stdio 子进程只继承宿主进程的 `PATH` 和配置中显式声明的环境变量，不继承宿主进程的其他环境变量（包括 API key、token 等凭证信息）。

**N3：`${VAR}` 展开安全**
配置中 `env` 和 `headers` 字段的值支持 `${VAR}` 语法展开为宿主进程环境变量。引用的变量不存在时，展开结果为空字符串，不报错中止。展开行为仅限于值字段，不允许展开 key 名称。

**N4：命名空间无冲突**
MCP 工具注册名由 `{serverName}__{toolName}` 格式构成（双下划线分隔），与内置工具名不冲突，不同 Server 的同名工具也相互隔离。

**N5：取消与超时传递**
工具执行上下文中的取消信号和超时时限透传到 MCP 调用层，Server 侧响应超时或宿主取消时，调用以标准工具错误码返回。

**N6：配置合并语义**
`mcp_servers` 采用 key 级合并：项目级条目覆盖同名用户级条目，不同名条目来自两层各自保留。这与主配置字段"互斥选一"的行为独立，不影响现有配置加载逻辑。

**N7：启动时机**
MCP Server 连接和工具发现在 AgentCode 启动阶段（工具注册表构建时）完成，Agent Loop 运行前所有 MCP 工具已就位。连接失败的 Server 只记录警告，不阻止 AgentCode 整体启动。

**N8：MCP 工具对 token 的影响**
对外暴露给 Provider 的工具声明列表不包含 MCP 工具，system prompt 中不包含任何 MCP 工具的 schema。`mcp_search_tools` 本身是唯一暴露给 Provider 的 MCP 相关工具。

## 不做的事

- **MCP 非工具能力**：不实现 Resources、Prompts、Sampling 等 MCP 协议能力，只对接 `tools/*` 相关消息。
- **Server 健康检查与自动重连**：不做心跳检测、失败后自动重试连接或重启子进程。Server 断开后其工具调用以错误返回，用户需手动重启 AgentCode。
- **工具子集白名单**：不支持在配置里声明"只允许某 Server 的哪些工具"，所有发现到的工具均可通过 `mcp_search_tools` 搜索到并调用。
- **risk 手动覆盖**：不支持在配置中为单个 MCP 工具手动指定 risk 级别。
- **`tools/list` 分页**：不处理 MCP `tools/list` 的分页游标，一次请求取回全部工具列表。
- **Server 动态热加载**：不支持运行时新增或移除 Server，配置变更需重启 AgentCode 生效。
- **MCP 工具结果的 redaction**：不对 MCP 工具返回内容做 secrets redaction，这与内置工具行为不同，属已知差异。

## 验收标准

**AC1（对应 F1）：配置文件可声明两种类型的 MCP Server**
在 `.agentcode/config.yaml` 中写入 `mcp_servers` 字段，分别声明一个 stdio 类型（含 `command`、`args`、`env`）和一个 http 类型（含 `url`、`headers`），AgentCode 启动时不报配置解析错误，两个 Server 均尝试连接。

**AC2（对应 F1）：`${VAR}` 展开生效**
在 `env` 或 `headers` 的值中写入 `${HOME}`，AgentCode 启动后该字段的值被替换为宿主进程对应的环境变量值。引用不存在的变量时值变为空字符串，不报错。

**AC3（对应 F2）：双层配置按 key 合并**
用户级配置声明 Server A 和 Server B，项目级配置声明 Server B（覆盖）和 Server C。AgentCode 启动后，可通过 `mcp_search_tools` 发现来自三个 Server 的工具，其中 Server B 的配置以项目级为准。

**AC4（对应 F3、F4）：握手与工具发现正常完成**
启动一个合法的 MCP Server（stdio 或 HTTP），AgentCode 启动日志可观察到握手完成，`mcp_search_tools` 能返回该 Server 的工具列表。

**AC5（对应 F5）：工具命名含 Server 前缀**
通过 `mcp_search_tools` 搜索到的工具名格式为 `{serverName}__{toolName}`，与内置工具名不冲突。

**AC6（对应 F6）：Agent 可调用 MCP 工具并得到结果**
Agent 通过 `mcp_search_tools` 找到工具后，直接用工具名发起调用，得到工具执行结果，整个过程与调用内置工具的交互方式一致。

**AC7（对应 F6）：超时约束生效**
超时时限到期后，MCP 工具调用返回超时错误，不挂起。

**AC8（对应 F7）：单 Server 失败不影响其他工具**
配置两个 MCP Server，故意让其中一个地址不可达，AgentCode 启动成功且界面显示该 Server 的警告信息，内置工具和另一个可达 Server 的工具正常可用。不可达 Server 的工具通过 `mcp_search_tools` 搜不到，调用时返回明确错误。

**AC9（对应 F8）：JSON-RPC 消息 id 正确配对**
并发发起多个工具调用时，每个调用收到的响应与其请求 id 一致，不出现响应错配。

**AC10（对应 F9）：子进程不继承宿主敏感环境变量**
启动一个 stdio MCP Server，其工具实现返回当前进程的环境变量列表，观察返回结果只含 `PATH` 和配置中显式声明的 `env` 键，不含宿主进程的其他变量。

**AC11（对应 F10、F11）：MCP 工具不预展开进 system prompt**
通过日志确认发往 Provider 的请求体中，工具声明列表只含内置工具和 `mcp_search_tools`，不含任何 MCP 工具的 schema。

**AC12（对应 F10）：`mcp_search_tools` 按关键词返回匹配工具**
输入关键词 `"file"`，`mcp_search_tools` 返回名称或描述中含 `"file"` 的工具列表（含名称、描述和输入 schema）。输入 `"zzznomatch"` 这类不存在的词时，返回空列表且不报错。

**AC13（对应 F12）：risk 推断结果合理**
工具名或描述含 read/get/list/查询等语义词的推断为 read，含 write/delete/create/删除等语义词的推断为 write，无法判断的推断为 execute。execute 级 MCP 工具在严格权限模式下触发权限确认流程。
