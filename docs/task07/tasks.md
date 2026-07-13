# MCP 客户端集成 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/transport/types.ts` | McpTransport 接口 |
| 新建 | `src/mcp/types.ts` | McpClient/McpManager/McpRawTool/McpCallResult 接口 |
| 新建 | `src/mcp/jsonrpc.ts` | JSON-RPC 2.0 消息层（JsonRpcDispatcher） |
| 新建 | `src/mcp/transport/StdioTransport.ts` | stdio 子进程传输（含 env 白名单 F9） |
| 新建 | `src/mcp/transport/HttpTransport.ts` | Streamable HTTP 传输 |
| 新建 | `src/mcp/McpClient.ts` | 单 Server 连接（握手、工具发现、工具调用） |
| 新建 | `src/config/mcpSchema.ts` | MCP 配置 Zod schema、${VAR} 展开、双层合并 |
| 修改 | `src/config/schema.ts` | RawConfig/AgentConfig 加可选 mcp_servers/mcpServers 字段 |
| 修改 | `src/config/loadConfig.ts` | 双层 mcp_servers 读取，调用 mergeMcpConfigs |
| 新建 | `src/mcp/McpToolAdapter.ts` | McpRawTool → ToolDefinition（命名、risk 推断、schema 归一化） |
| 新建 | `src/mcp/McpManager.ts` | 并发初始化、失败隔离、工具搜索 |
| 新建 | `src/tools/builtins/mcpSearchTools.ts` | mcp_search_tools 工具实现 |
| 修改 | `src/tools/registry.ts` | 新增 CompositeToolRegistry、createCompositeRegistry、createStaticRegistry |
| 修改 | `src/tools/builtins/index.ts` | 导出 createMcpSearchTool |
| 修改 | `src/app/bootstrapApp.tsx` | initMcpManager、createCompositeRegistry 组装，SIGINT/SIGTERM 清理 |
| 新建 | `tests/unit/mcp/jsonrpc.test.ts` | id 配对、超时、并发 |
| 新建 | `tests/unit/mcp/McpClient.test.ts` | 握手、工具发现、调用代理（mock transport） |
| 新建 | `tests/unit/mcp/McpManager.test.ts` | 失败隔离 |
| 新建 | `tests/unit/mcp/McpToolAdapter.test.ts` | 命名格式、risk 推断、schema 归一化 |
| 新建 | `tests/unit/mcp/mcpSearchTools.test.ts` | 关键词匹配、空结果 |
| 新建 | `tests/unit/mcp/CompositeRegistry.test.ts` | getProviderDeclarations 不含 MCP、get 两层查 |
| 新建 | `tests/unit/mcp/transport/StdioTransport.test.ts` | env 白名单（spy on spawn） |
| 新建 | `tests/unit/config/mcpSchema.test.ts` | 配置解析、${VAR} 展开、双层合并 |

## T1: MCP 接口类型定义

**文件：** `src/mcp/transport/types.ts`、`src/mcp/types.ts`
**依赖：** 无
**步骤：**
1. 创建 `src/mcp/transport/types.ts`，定义 `McpTransport` 接口：`send(message: string): Promise<void>`、`messages(): AsyncIterable<string>`、`close(): Promise<void>`
2. 创建 `src/mcp/types.ts`，定义以下接口：
   - `McpRawTool`：`name: string; description?: string; inputSchema?: unknown`
   - `McpCallResult`：`text: string; isError: boolean`
   - `McpClientOptions`：`serverName: string; transport: McpTransport; connectTimeoutMs?: number`
   - `McpClient`：`connect(): Promise<void>`、`listTools(): Promise<McpRawTool[]>`、`callTool(name, args, signal?, timeoutMs?): Promise<McpCallResult>`、`close(): Promise<void>`
   - `McpManagerInitResult`：`serverName: string; status: 'connected' | 'failed'; tools: ToolDefinition[]; warning?: string`
   - `McpManager`：`getTools(): readonly ToolDefinition[]`、`searchTools(query: string): ToolDefinition[]`、`closeAll(): Promise<void>`

**验证：** `npm run typecheck` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T2: JSON-RPC 2.0 消息层

**文件：** `src/mcp/jsonrpc.ts`
**依赖：** T1
**步骤：**
1. 定义消息类型：`JsonRpcRequest`（含整数 id 自增）、`JsonRpcNotification`（无 id）、`JsonRpcSuccess`、`JsonRpcError`、`JsonRpcResponse`
2. 实现 `JsonRpcDispatcher` 类（per-instance id 计数器和 pending map）：
   - `sendRequest(transport, method, params, signal?, timeoutMs?): Promise<unknown>`：生成唯一 id，注册 pending 回调，发送请求，超时/abort 时 reject 并清除
   - `sendNotification(transport, method, params): Promise<void>`：构造无 id 消息直接发送
   - `dispatch(rawMessage: string): void`：解析消息，按 id 路由到 pending map
   - `rejectAll(error: Error): void`：批量 reject 所有未完成 pending（transport 关闭时调用）
3. 消息监听循环由 McpClient 启动（单循环架构），jsonrpc 层只负责注册和路由

**验证：** `npm run typecheck` 通过；`npm test -- tests/unit/mcp/jsonrpc.test.ts` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T3: StdioTransport 实现

**文件：** `src/mcp/transport/StdioTransport.ts`
**依赖：** T1
**步骤：**
1. 实现 `createStdioTransport(entry: { command, args, env }): McpTransport`
2. 启动子进程时 env 只传 `{ PATH: process.env.PATH, ...entry.env }`（F9 安全要求）
3. `send(message)` 向子进程 stdin 写入 `message + '\n'`
4. `messages()` async generator，从 stdout 按行读取（readline），每行 yield；忽略空行
5. `close()` 调用 `childProcess.kill()`，唤醒所有等待者让迭代器退出
6. stderr 静默丢弃

**验证：** `npm run typecheck` 通过；`npm test -- tests/unit/mcp/transport/StdioTransport.test.ts` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T4: HttpTransport 实现

**文件：** `src/mcp/transport/HttpTransport.ts`
**依赖：** T1
**步骤：**
1. 实现 `createHttpTransport(entry: { url, headers }): McpTransport`
2. `send(message)` 向 url 发 POST 请求，Content-Type: application/json，附带 headers，流式读取响应体按行 enqueue
3. `messages()` async generator，从内部队列 yield
4. `close()` 为 no-op（HTTP 无长连接），唤醒等待者让迭代器退出

**验证：** `npm run typecheck` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T5: McpClient 实现

**文件：** `src/mcp/McpClient.ts`
**依赖：** T1、T2
**步骤：**
1. 实现 `createMcpClient(options: McpClientOptions): McpClient`
2. `connect()` 流程：
   - 启动单一共享消息分发循环（`for await` transport.messages()，驱动 dispatcher.dispatch()）
   - 发送 `initialize` 请求（protocolVersion: '2024-11-05'），等待响应，默认超时 10_000ms
   - 发送 `notifications/initialized` 通知（无 id）
3. `listTools()` 发送 `tools/list`，返回 result.tools 数组（不处理分页）
4. `callTool(name, args, signal?, timeoutMs?)` 发送 `tools/call`，归一化 content 数组（text 拼接，image/resource 用占位符），isError 映射
5. `close()` 设 loopStopped=true，关闭 transport，等待循环退出；循环退出时 rejectAll

**验证：** `npm run typecheck` 通过；`npm test -- tests/unit/mcp/McpClient.test.ts` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T6: MCP 配置 schema 与双层合并

**文件：** `src/config/mcpSchema.ts`（新建）、`src/config/schema.ts`（修改）、`src/config/loadConfig.ts`（修改）
**依赖：** 无（可与 T1-T5 并行）
**步骤：**
1. 创建 `src/config/mcpSchema.ts`：
   - Zod schema（discriminated union：stdio/http）
   - `expandEnvVars(value: string): string`：单次 String.replace，`${VAR}` → `process.env[VAR] ?? ''`
   - `parseMcpServersConfig(raw: unknown): McpServersConfig`：解析并展开 env/headers 值
   - `mergeMcpConfigs(global?, project?): McpServersConfig`：key 级合并，project 覆盖同名 global
2. 修改 `src/config/schema.ts`：
   - `RawConfig` 加 `mcp_servers?: Record<string, unknown>`
   - `rawConfigSchema` 在 `.strict()` 前加 `mcp_servers: z.record(...).optional()`
   - `AgentConfig` 加 `mcpServers?: McpServersConfig`
3. 修改 `src/config/loadConfig.ts`：
   - project 配置存在时额外读取 global 的 mcp_servers（`readMcpServersOnly` 辅助函数）
   - 调用 `mergeMcpConfigs` 合并，结果挂到 `resolvedConfig.config.mcpServers`

**验证：** `npm run typecheck` 通过；`npm test -- tests/unit/config/` 现有测试不破坏；`npm test -- tests/unit/config/mcpSchema.test.ts` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T7: McpToolAdapter 实现

**文件：** `src/mcp/McpToolAdapter.ts`
**依赖：** T1
**步骤：**
1. `inferRisk(name, description): ToolRisk`：大小写不敏感关键词匹配，execute > write > read，无法判断兜底 execute
2. `normalizeMcpSchema(rawSchema): ToolJsonSchema`：object/array 降级为 string + JSON 说明，标量保持不变，缺少 schema 返回空对象
3. `adaptMcpTool(serverName, raw, callFn): ToolDefinition`：名称 `serverName__toolName`，risk 推断，schema 归一化，execute 调用 callFn 并映射结果

**验证：** `npm run typecheck` 通过；`npm test -- tests/unit/mcp/McpToolAdapter.test.ts` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T8: McpManager 实现

**文件：** `src/mcp/McpManager.ts`
**依赖：** T5、T6、T7
**步骤：**
1. `initMcpManager(configs, createTransport)`: Promise<{ manager, initResults }>
2. `Promise.allSettled` 并发初始化，每个 Server：createTransport → createMcpClient → connect → listTools → adaptMcpTool
3. 失败时 status='failed'，warning 记录摘要（不含 stack），console.warn 输出
4. `searchTools(query)`: 按空白拆词，任一词命中 name+description 即纳入
5. `closeAll()`: Promise.allSettled 并发关闭，失败静默

**验证：** `npm run typecheck` 通过；`npm test -- tests/unit/mcp/McpManager.test.ts` 通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T9: CompositeToolRegistry 与 mcp_search_tools

**文件：** `src/tools/registry.ts`（修改）、`src/tools/builtins/mcpSearchTools.ts`（新建）、`src/tools/builtins/index.ts`（修改）
**依赖：** T8
**步骤：**
1. `registry.ts` 新增 `CompositeToolRegistry`：
   - `getProviderDeclarations()` 只返回 providerTools 声明（MCP 工具不暴露）
   - `get()` 两层查找（provider 优先，再 hiddenTools）
   - `filterByRisk()` 两层都过滤，返回新 CompositeToolRegistry
   - `createCompositeRegistry` 工厂函数
   - `createStaticRegistry` 工厂函数（从任意 ToolDefinition[] 创建）
2. 新建 `mcpSearchTools.ts`：`createMcpSearchTool(manager): ToolDefinition`，risk=read，格式化返回匹配工具列表
3. `builtins/index.ts` 导出 `createMcpSearchTool`

**验证：** `npm run typecheck` 通过；`npm test -- tests/unit/mcp/CompositeRegistry.test.ts tests/unit/mcp/mcpSearchTools.test.ts` 通过；`npm test -- tests/unit/tools/registry.test.ts` 不破坏

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T10: bootstrapApp 集成组装

**文件：** `src/app/bootstrapApp.tsx`（修改）
**依赖：** T8、T9、T6
**步骤：**
1. loadConfig 后检查 `mcpServers`，非空时调用 `initMcpManager`（条件门控，无配置走原路径）
2. `createDefaultTransport(entry)` 根据 type 返回 StdioTransport 或 HttpTransport
3. 注册 `process.once('SIGINT'/'SIGTERM')` 清理（不用 'exit'，该事件是同步的）
4. `createStaticRegistry([...builtins, mcpSearchTool])` 作为 providerTools
5. `createCompositeRegistry(providerTools, hiddenMap)` 作为最终 toolRegistry
6. 无 MCP 配置时直接用 `createDefaultToolRegistry()`，行为不变

**验证：** `npm run typecheck` 通过；`npm test` 全量无新增失败

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## T11: 全量集成验证

**文件：** 无新建文件
**依赖：** T10
**步骤：**
1. `npm run typecheck` — 全量类型检查，期望 0 errors
2. `npm test` — 全量测试，记录通过/失败数
3. `npm test -- tests/unit/mcp/` — MCP 专项测试全部通过
4. `npm run e2e:tmux`（如可用）— 端到端验证；不可用时记录为环境阻塞

**验证：** typecheck 0 errors；单元测试核心用例全部通过

**任务后审查：** 验证通过后，启动至少 3 个子代理从不同角度审查本任务相关代码变更；若无法启动 3 个子代理，停止执行并告知用户，不得标记本任务完成。

## 执行顺序

```
T1（接口类型）
 │
 ├─→ T2（JSON-RPC）─→ T5（McpClient）─→ T8（McpManager）─→ T9（CompositeRegistry）─→ T10（bootstrapApp）─→ T11
 │                                         ↑
 ├─→ T3（StdioTransport）─────────────────┤
 ├─→ T4（HttpTransport）─────────────────┤
 └─→ T7（McpToolAdapter）────────────────┘

T6（MCP 配置 schema，可与 T1-T5 并行）─→ T8 依赖 T6
```
