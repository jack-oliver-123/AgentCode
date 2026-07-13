# MCP 客户端集成 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 审查来源

- spec.md 验收标准：已覆盖（AC1~AC13 全部转化为下方验证项）
- plan.md 风险与回滚：已覆盖（pending map 并发安全、loadConfig 双层读取、env 白名单、closeAll 时机）
- 当前分支 vs main diff：无 task07 实现代码可审，已由 2 个只读子代理从不同角度审查"空 diff + 已批准 spec/plan/tasks + 现有代码上下文"；明确记录"无实现 diff 可审"
- 子代理发现处理：有效发现已转化为下方可验证条目，原始审查报告不写入本文档。共识性高风险发现（pending map 单循环、transport close 批量 reject、loadConfig 双层读取改动、closeAll 异步时机、expandEnvVars 单次展开）已纳入"回归与风险检查"节。

## 实现完整性

- [ ] `src/mcp/` 目录存在，包含 types.ts、jsonrpc.ts、McpClient.ts、McpManager.ts、McpToolAdapter.ts（验证：`npm run typecheck` 通过，无缺失引用）
- [ ] `src/mcp/transport/` 包含 types.ts、StdioTransport.ts、HttpTransport.ts（验证：typecheck 通过）
- [ ] `src/config/mcpSchema.ts` 存在，导出 `parseMcpServersConfig`、`mergeMcpConfigs`、`expandEnvVars`（验证：typecheck 通过）
- [ ] `src/tools/builtins/mcpSearchTools.ts` 存在，导出 `createMcpSearchTool`（验证：typecheck 通过）
- [ ] `src/tools/registry.ts` 新增 `CompositeToolRegistry` 和 `createCompositeRegistry`（验证：typecheck 通过）

## 配置解析（AC1、AC2、AC3）

- [ ] AC1：在 `.agentcode/config.yaml` 写入 stdio 类型（含 command、args、env）和 http 类型（含 url、headers）的 `mcp_servers` 条目，AgentCode 启动不报配置解析错误（验证：`npm run dev` 启动无 ZodError）
- [ ] AC1-schema：`rawConfigSchema` 对 `mcp_servers` 字段以 optional 形式处理，其余字段保持 strict 验证；在 YAML 中写入无关字段仍报错（验证：单元测试 `mcpSchema.test.ts`）
- [ ] AC2：`env` 或 `headers` 值含 `${HOME}` 时，AgentCode 启动后该字段值被替换为宿主 `process.env.HOME`（验证：`npm test -- tests/unit/config/mcpSchema.test.ts`）
- [ ] AC2-missing：引用不存在的 `${NONEXISTENT_VAR_XYZ}` 时值变为空字符串，不报错（验证：单元测试）
- [ ] AC3：用户级声明 Server A + Server B，项目级声明 Server B（不同 config）+ Server C；合并后三个 Server 均存在，Server B 以项目级配置为准（验证：`mcpSchema.test.ts` mergeMcpConfigs 用例）
- [ ] AC3-loadConfig：当 project 配置存在时，`loadConfig` 仍额外读取 global 配置文件的 `mcp_servers` 字段进行合并；global 文件不存在时以 project 层为准，不报错（验证：`loadConfig.test.ts` 扩展用例）

## JSON-RPC 消息层（AC9）

- [ ] AC9：并发发起 3 个 `sendRequest`，每个响应 id 与其请求 id 一致，不出现响应错配（验证：`npm test -- tests/unit/mcp/jsonrpc.test.ts`）
- [ ] 单循环架构：`jsonrpc.ts` 内部使用单一共享消息分发循环（由 McpClient 启动），不在每次 `sendRequest` 内独立迭代 transport（验证：代码审查 + 并发测试）
- [ ] id 唯一性：id 计数器是 per-McpClient 实例，不是全局变量（验证：typecheck + 单元测试同时创建两个 McpClient 不互相干扰）

## 传输层（AC10）

- [ ] AC10：stdio 子进程的 env 只含 `PATH` 和配置中显式声明的键，不含宿主进程的 `API_KEY`、`ANTHROPIC_API_KEY` 等其他环境变量（验证：`npm test -- tests/unit/mcp/transport/StdioTransport.test.ts`，spy on spawn 检查 env 参数）
- [ ] HTTP transport：`close()` 为 no-op，不抛异常（验证：单元测试）

## MCP 连接与工具发现（AC4、AC7、AC8）

- [ ] AC4：对合法的 stdio Server 启动后，日志可观察到握手完成（`initialized` 通知已发送），`mcp_search_tools` 能返回该 Server 的工具（验证：端到端场景或集成测试）
- [ ] AC7：工具调用超时时，MCP 工具返回超时错误，调用不挂起（验证：`McpClient.test.ts` 中 mock transport 延迟响应超过 timeoutMs）
- [ ] AC8：配置两个 Server，其中一个地址不可达；AgentCode 启动成功，不可达 Server 产生警告信息（console.warn 或 TUI 可见），内置工具和可达 Server 的工具正常可用（验证：`McpManager.test.ts` 失败隔离用例）
- [ ] transport close 批量 reject：transport 意外关闭时，pending map 中所有未 settle 的 Promise 以错误 reject，不永久挂起（验证：`McpClient.test.ts` 模拟 transport 突然关闭）
- [ ] 后台分发循环不产生 Unhandled Promise Rejection：循环内部异常被 catch 处理（验证：单元测试模拟循环内部抛异常）

## 工具适配与注册（AC5、AC6、AC12、AC13）

- [ ] AC5：`mcp_search_tools` 返回的工具名格式为 `{serverName}__{toolName}`（双下划线），不与内置工具名冲突（验证：`npm test -- tests/unit/mcp/McpToolAdapter.test.ts`）
- [ ] AC6：Agent 通过 `mcp_search_tools` 找到工具后，用 `serverName__toolName` 发起调用，得到执行结果，整个过程与内置工具一致（验证：端到端场景）
- [ ] AC12：输入 `"file"`，`mcp_search_tools` 返回名称或描述含 "file" 的工具列表（含 name、description、inputSchema）；输入 `"zzznomatch"` 返回空列表且不报错（验证：`mcpSearchTools.test.ts`）
- [ ] AC13 read 推断：工具名或描述含 read/get/list/search/query/fetch/读取/查询/列出/搜索/获取 推断为 read（验证：`McpToolAdapter.test.ts`）
- [ ] AC13 write 推断：含 write/create/update/delete/modify/remove/set/写入/创建/更新/删除/修改 推断为 write（验证：`McpToolAdapter.test.ts`）
- [ ] AC13 execute 推断：无法判断或含 execute/run/invoke/call/执行/运行 推断为 execute（验证：`McpToolAdapter.test.ts`）；execute 级 MCP 工具在 strict 模式下触发权限确认流程（验证：集成测试或手动验证）
- [ ] schema 归一化：object/array 类型属性降级为 string + description 注明传 JSON 字符串；string/number/boolean 保持不变（验证：`McpToolAdapter.test.ts`）

## CompositeToolRegistry（AC11）

- [ ] AC11：发往 Provider 的请求体中，工具声明列表只含内置工具和 `mcp_search_tools`，不含任何 MCP 工具的 schema（验证：`CompositeRegistry.test.ts` 中 `getProviderDeclarations()` 断言）
- [ ] `get(name)` 能查到 hiddenTools 中的 MCP 工具（验证：`CompositeRegistry.test.ts`）
- [ ] `filterByRisk` 两层都过滤，返回的 registry 中 `getProviderDeclarations()` 仍只含 providerTools 侧的声明（验证：单元测试）

## 安全与隔离（N1、N2、N3）

- [ ] N1 失败隔离：单个 Server 握手失败，其他 Server 工具正常可用，内置工具正常可用（验证：`McpManager.test.ts`）
- [ ] N2 env 白名单：子进程 spawn 的 env 参数不含 `process.env` 中宿主的其他字段（验证：StdioTransport.test.ts spy）
- [ ] N3 单次展开：`expandEnvVars` 使用单次 `String.replace`，不循环替换；当 `process.env.A = "${B}"` 且配置 `env.K: "${A}"` 时，展开结果为字面量 `${B}`，不进一步替换 B（验证：`mcpSchema.test.ts` 单次展开断言）
- [ ] N3 仅值展开：`expandEnvVars` 只对 env/headers 的值调用，不对 key 名称调用（验证：代码审查 + `mcpSchema.test.ts`）

## 生命周期管理

- [ ] `closeAll()` 不使用 `process.on('exit')`（'exit' 事件是同步的，无法执行异步操作）；改用 `process.on('SIGINT')`/`process.on('SIGTERM')` 并 await closeAll() 后 process.exit()，或在 'exit' 中只调用同步的子进程 kill 信号（验证：代码审查）
- [ ] 无 MCP 配置时（`mcpServers` 为空或 undefined），bootstrapApp 直接使用 `createDefaultToolRegistry()`，行为与当前完全一致（验证：`npm test` 现有会话测试不破坏）

## 编译与测试

- [ ] `npm run typecheck` 通过（0 errors）
- [ ] `npm test -- tests/unit/mcp/` 全部通过
- [ ] `npm test -- tests/unit/config/mcpSchema.test.ts` 通过
- [ ] `npm test` 全量运行，已知 flaky 文件系统测试（write-file、run-command、edit-file）除外，无新增失败
- [ ] `npm test -- tests/unit/tools/registry.test.ts` 现有 registry 测试不破坏
- [ ] `npm test -- tests/unit/config/loadConfig.test.ts` 现有 loadConfig 测试不破坏

## 回归与风险检查

- [ ] `rawConfigSchema` 其余字段 strict 验证未被放宽：在 YAML 中写入 `unknown_field: true` 仍报 ZodError（验证：`loadConfig.test.ts`）
- [ ] `AgentConfig` 新增 `mcpServers?` 字段不产生类型循环依赖：`schema.ts` 引用 `mcpSchema.ts` 中的类型，typecheck 通过即验证（验证：`npm run typecheck`）
- [ ] `loadConfig` 互斥选一主逻辑不受影响：有 project 配置时，主配置仍从 project 读取，global 只额外提取 `mcp_servers`（验证：`loadConfig.test.ts` 现有用例 + 新增用例）
- [ ] MCP 工具调用经过现有 PermissionChecker 五层管道，不绕过权限检查（验证：execute risk 工具在 strict 模式下触发 askPermission 回调）
- [ ] 工具调用 signal 和 timeoutMs 从 ToolExecutionContext 正确传递到 `McpClient.callTool`（验证：`McpClient.test.ts` 超时用例）

## 端到端场景

- [ ] 场景 1（基本工具发现）：在 `.agentcode/config.yaml` 配置一个真实 stdio MCP Server → AgentCode 启动 → 输入 "搜索 mcp 工具" → Agent 调用 `mcp_search_tools` → 返回工具列表 → 整个流程无报错
- [ ] 场景 2（工具调用）：Agent 通过 `mcp_search_tools` 找到一个工具后 → 直接用 `serverName__toolName` 调用 → 得到执行结果 → 结果格式与内置工具一致
- [ ] 场景 3（失败隔离）：配置一个不可达的 Server + 一个正常 Server → AgentCode 启动 → 界面出现不可达 Server 的警告 → 正常 Server 的工具通过 `mcp_search_tools` 可搜索到 → 内置工具正常调用
- [ ] 场景 4（无 MCP 配置兼容）：`.agentcode/config.yaml` 不含 `mcp_servers` 字段 → AgentCode 启动正常 → 内置工具可用 → `mcp_search_tools` 不出现在工具列表中
