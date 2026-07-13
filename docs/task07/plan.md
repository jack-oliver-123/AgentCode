# MCP 客户端集成 Plan

## 方案选择摘要

- **候选方案来源：** 3 个子代理分别从「最小可行（使用 @modelcontextprotocol/sdk）」、「测试与回滚（可注入 transport 接口）」、「架构一致性（自实现 JSON-RPC，不引外部 SDK）」角度提出候选方案。
- **最终选择：** 架构一致性方案，并吸收测试方案的 McpTransport 可注入接口、`Promise.allSettled` 并发连接、per-request pending map、子进程 env 白名单设计。
- **选择理由：** 项目无大型运行时依赖，引入 SDK 与现有风格不符；CLAUDE.md Issue #11 教训说明代理网关对复杂 JSON Schema 有 bug，SDK 生成的 schema 可能触发同一问题；JSON-RPC 2.0 协议简单，自实现约 150 行，可读性高；McpTransport 接口保留完整可测试性，单元测试无需启动真实子进程。
- **丢弃说明：** 最小可行方案（依赖外部 SDK）和测试方案（作为独立架构）不作为 tasks.md 依据；测试方案中的可注入 transport 接口、失败隔离模式已吸收进最终方案。

## 架构概览

```
bootstrapApp
  ├─ loadConfig()               → AgentConfig + McpServersConfig（双层合并）
  ├─ initMcpManager()           → McpManager（并发连接，失败隔离）
  │     ├─ McpClient("fs")      → StdioTransport → connected ✓
  │     ├─ McpClient("github")  → StdioTransport → FAILED ✗（只影响该 Server）
  │     └─ McpClient("api")     → HttpTransport  → connected ✓
  └─ createCompositeRegistry(builtins, mcpManager)
        ├─ providerSet: 6 内置工具 + mcp_search_tools   → getProviderDeclarations()
        └─ hiddenSet:   MCP 工具（按名可查）            → get(name)
```

Agent 调用流转：
1. `getProviderDeclarations()` 只暴露内置工具 + `mcp_search_tools`
2. Agent 调用 `mcp_search_tools(query)` 搜索匹配工具，得到名称 + 描述 + inputSchema
3. Agent 凭 schema 在后续迭代直接调用 `serverName__toolName(args)`
4. `registry.get('serverName__toolName')` 从 hiddenSet 找到工具，走同一套工具执行流程

## 核心数据结构

### McpServerEntry（配置，discriminated union）

```typescript
// 原始配置（YAML snake_case）
interface RawMcpServerEntry {
  type: 'stdio' | 'http';
  command?: string;                     // stdio 专用
  args?: string[];                      // stdio 专用
  env?: Record<string, string>;         // 值支持 ${VAR} 展开；stdio 专用
  url?: string;                         // http 专用
  headers?: Record<string, string>;     // 值支持 ${VAR} 展开；http 专用
}
type RawMcpServersConfig = Record<string, RawMcpServerEntry>;

// 运行时归一化（camelCase，discriminated union）
type McpServerEntry =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };
type McpServersConfig = Record<string, McpServerEntry>;
```

### McpTransport（可注入接口）

```typescript
// src/mcp/transport/types.ts
interface McpTransport {
  send(message: string): Promise<void>;
  messages(): AsyncIterable<string>;
  close(): Promise<void>;
}
```

### JSON-RPC 消息类型

```typescript
// src/mcp/jsonrpc.ts
interface JsonRpcRequest      { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
interface JsonRpcSuccess      { jsonrpc: '2.0'; id: number; result: unknown }
interface JsonRpcError        { jsonrpc: '2.0'; id: number; error: { code: number; message: string; data?: unknown } }
type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// 核心函数
function sendRequest(transport, method, params, signal?, timeoutMs?): Promise<unknown>
function sendNotification(transport, method, params): Promise<void>
```

### McpClient（单 Server 连接）

```typescript
// src/mcp/McpClient.ts
interface McpClientOptions {
  serverName: string;
  transport: McpTransport;
  connectTimeoutMs?: number;  // 默认 10_000
}

interface McpClient {
  connect(): Promise<void>;              // F3: initialize → initialized
  listTools(): Promise<McpRawTool[]>;    // F4: tools/list
  callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<McpCallResult>;
  close(): Promise<void>;
}

interface McpRawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;  // 原始 MCP schema，后续归一化
}

interface McpCallResult {
  text: string;       // content 数组 text 条目拼接；image/resource 用占位符
  isError: boolean;
}
```

### McpManager（连接池）

```typescript
// src/mcp/McpManager.ts
interface McpManagerInitResult {
  serverName: string;
  status: 'connected' | 'failed';
  tools: ToolDefinition[];
  warning?: string;
}

interface McpManager {
  getTools(): readonly ToolDefinition[];
  searchTools(query: string): ToolDefinition[];  // F10 关键词搜索
  closeAll(): Promise<void>;
}

async function initMcpManager(
  configs: McpServersConfig,
  createTransport: (entry: McpServerEntry) => McpTransport,  // 可注入，测试用
): Promise<{ manager: McpManager; initResults: McpManagerInitResult[] }>
```

### CompositeToolRegistry

```typescript
// src/tools/registry.ts（新增，不改 StaticToolRegistry）
class CompositeToolRegistry implements ToolRegistry {
  constructor(
    private readonly providerTools: ToolRegistry,           // 内置 + mcp_search_tools
    private readonly hiddenTools: ReadonlyMap<string, ToolDefinition>, // MCP 工具
  ) {}

  list(): readonly ToolDefinition[]                         // 两层合并
  get(name: string): ToolDefinition | undefined             // 两层都查
  getProviderDeclarations(): ProviderToolDeclaration[]      // 只返回 providerTools（F10/F11）
  filterByRisk(allowedRisks: ToolRisk[]): ToolRegistry      // 两层都过滤
}
```

## 模块设计

### src/mcp/transport/types.ts
**职责：** McpTransport 接口定义
**对外接口：** `McpTransport`
**依赖：** 无

### src/mcp/transport/StdioTransport.ts
**职责：** 启动子进程，建立 stdin/stdout 双向管道，按行读取 JSON-RPC 消息
**对外接口：** `createStdioTransport(entry: McpServerEntry & { type: 'stdio' }): McpTransport`
**依赖：** Node.js `child_process`；F9 env 白名单（只传 `PATH` + `entry.env`）

### src/mcp/transport/HttpTransport.ts
**职责：** 向 HTTP 端点发送 POST 请求，读取 Streamable HTTP 响应行
**对外接口：** `createHttpTransport(entry: McpServerEntry & { type: 'http' }): McpTransport`
**依赖：** Node.js `fetch`

### src/mcp/jsonrpc.ts
**职责：** JSON-RPC 2.0 消息构造、id 生成、请求/响应配对（pending map）、超时处理
**对外接口：** `sendRequest`、`sendNotification`
**依赖：** McpTransport

### src/mcp/McpClient.ts
**职责：** 单 Server 连接生命周期——握手（F3）、工具发现（F4）、工具调用代理（F6）
**对外接口：** `createMcpClient(options): McpClient`
**依赖：** jsonrpc.ts

### src/mcp/McpToolAdapter.ts
**职责：** McpRawTool → ToolDefinition（F5 命名 `serverName__toolName`、F12 risk 推断、schema 归一化——复杂类型降级为 string）
**对外接口：** `adaptMcpTool(serverName, raw, callFn): ToolDefinition`、`inferRisk(name, description): ToolRisk`
**依赖：** ToolDefinition 类型

### src/mcp/McpManager.ts
**职责：** `Promise.allSettled` 并发初始化所有 Server（F7 失败隔离）、持有连接池、提供工具搜索（F10）
**对外接口：** `initMcpManager(configs, createTransport)`
**依赖：** McpClient, McpToolAdapter

### src/tools/builtins/mcpSearchTools.ts
**职责：** `mcp_search_tools` 内置工具实现（F10），query 字符串 → `manager.searchTools()` → 结果文本
**对外接口：** `createMcpSearchTool(manager): ToolDefinition`
**依赖：** McpManager

### src/tools/registry.ts（修改）
**职责：** 新增 `CompositeToolRegistry`；`createCompositeRegistry` 工厂函数
**对外接口：** `createCompositeRegistry(providerTools, mcpTools): ToolRegistry`
**依赖：** ToolRegistry 接口

### src/config/mcpSchema.ts（新建）
**职责：** MCP 配置 Zod schema、`${VAR}` 展开、双层 key 级合并（F1、F2）
**对外接口：** `parseMcpServersConfig(raw): McpServersConfig`、`mergeMcpConfigs(global?, project?): McpServersConfig`、`expandEnvVars(value): string`
**依赖：** zod

## 模块交互

```
bootstrapApp
  │
  ├─1─ loadConfig()
  │      └─ parseMcpServersConfig + mergeMcpConfigs  ← mcpSchema.ts
  │
  ├─2─ initMcpManager(mcpServersConfig, createTransport)
  │      └─ Promise.allSettled(servers.map(connectOne))
  │           connectOne:
  │             transport = createTransport(entry)    ← Stdio | Http
  │             client = createMcpClient({ transport })
  │             client.connect()                      ← jsonrpc: initialize + initialized
  │             rawTools = client.listTools()         ← jsonrpc: tools/list
  │             tools = rawTools.map(adaptMcpTool)    ← McpToolAdapter
  │
  ├─3─ mcpSearchTool = createMcpSearchTool(manager)
  │
  ├─4─ providerRegistry = StaticToolRegistry([...builtins, mcpSearchTool])
  │     hiddenMap = new Map(manager.getTools().map(t => [t.name, t]))
  │     registry = createCompositeRegistry(providerRegistry, hiddenMap)
  │
  └─5─ new ChatSessionController({ toolRegistry: registry, ... })

Agent 调用时：
  registry.getProviderDeclarations()      → 只含内置工具 + mcp_search_tools
  Agent 调用 mcp_search_tools(query)
    → manager.searchTools(query)          → 匹配 ToolDefinition 列表（含 inputSchema）
  Agent 调用 serverName__toolName(args)
    → registry.get('serverName__toolName')→ hiddenSet 中的 ToolDefinition
    → ToolDefinition.execute()            → client.callTool() → jsonrpc: tools/call
```

## 文件组织

```
src/
├── mcp/
│   ├── types.ts                    — McpClient、McpManager、McpRawTool、McpCallResult 接口
│   ├── jsonrpc.ts                  — JSON-RPC 2.0 消息层（id 生成、pending map、超时）
│   ├── McpClient.ts                — 单 Server 连接（握手、工具发现、工具调用）
│   ├── McpManager.ts               — 并发初始化、失败隔离、工具搜索
│   ├── McpToolAdapter.ts           — McpRawTool → ToolDefinition（命名、schema 归一化、risk）
│   └── transport/
│       ├── types.ts                — McpTransport 接口
│       ├── StdioTransport.ts       — child_process 子进程 + env 白名单（F9）
│       └── HttpTransport.ts        — fetch POST + 响应行读取
├── config/
│   ├── schema.ts                   — 修改：RawConfig 加可选 mcp_servers 字段
│   ├── mcpSchema.ts                — 新建：MCP 配置 Zod schema、${VAR} 展开、双层合并
│   └── loadConfig.ts               — 修改：调用 mergeMcpConfigs，AgentConfig 加 mcpServers
├── tools/
│   ├── registry.ts                 — 修改：新增 CompositeToolRegistry、createCompositeRegistry
│   └── builtins/
│       ├── mcpSearchTools.ts       — 新建：mcp_search_tools 工具实现
│       └── index.ts                — 修改：导出 createMcpSearchTool
└── app/
    └── bootstrapApp.tsx            — 修改：initMcpManager、createCompositeRegistry 组装

tests/
└── unit/
    └── mcp/
        ├── jsonrpc.test.ts         — id 配对、超时、并发
        ├── McpClient.test.ts       — 握手、工具发现、调用代理（mock transport）
        ├── McpManager.test.ts      — 失败隔离（1/3 失败不影响其他）
        ├── McpToolAdapter.test.ts  — 命名格式、risk 推断、schema 归一化
        ├── mcpSearchTools.test.ts  — 关键词匹配、空结果
        ├── CompositeRegistry.test.ts — getProviderDeclarations 不含 MCP、get 两层查
        └── transport/
            └── StdioTransport.test.ts — env 白名单（spy on spawn）
```

## 风险与回滚

- **可能破坏的现有行为：** `loadConfig` 返回值新增可选 `mcpServers` 字段，现有调用方无感知；`createDefaultToolRegistry()` 签名不变，`bootstrapApp` 条件选择 registry 实现。
- **安全/权限影响：** F9 子进程 env 白名单是安全核心，`StdioTransport` 只传 `{ PATH, ...entry.env }`，绝不扩散 `process.env` 其他字段；MCP 工具调用走现有 PermissionChecker 五层管道，risk 由 F12 推断注入。
- **数据兼容性：** `mcp_servers` 字段用 Zod `.optional()` 处理，现有配置无该字段时完全兼容；双层合并只针对 `mcp_servers`，主配置保持"互斥选一"语义。
- **回滚方案：** 配置级——删除 `mcp_servers` 字段，`bootstrapApp` 条件门控跳过 MCP 初始化，行为与现在完全一致；代码级——`initMcpManager` 只在 `mcpServersConfig` 非空时执行，无 MCP 配置时不运行任何 MCP 相关代码。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| MCP 协议库 | 自实现 JSON-RPC 2.0（约 150 行） | 项目无大型外部依赖；CLAUDE.md Issue #11 教训：外部 SDK 生成的复杂 schema 在代理网关有 bug；自实现精确控制 schema 归一化 |
| McpTransport 接口 | 可注入接口（`send` + `messages()` + `close()`） | 单元测试直接注入 mock，无需启动真实子进程；Stdio/HTTP 切换对上层透明 |
| F10/F11 实现 | CompositeToolRegistry 双集合（providerSet / hiddenSet） | 不改动 `ToolRegistry` 接口；`getProviderDeclarations()` 自然排除 MCP 工具；`get()` 两层都查，AgentLoop 无感知差异 |
| MCP 工具 inputSchema 归一化 | 复杂类型（array/object）降级为 `string` + description 注明传 JSON 字符串 | 与 `submitPlan.ts` 模式一致；防止代理网关 schema bug；`ToolJsonSchemaProperty` 类型约束不变 |
| F2 双层合并 | `mcp_servers` key 级合并，主配置保持互斥选一 | spec 明确要求；实现独立在 `mcpSchema.ts`，不污染 `loadConfig` 主流程 |
| 连接时机 | `bootstrapApp` 启动阶段 `Promise.allSettled` 并发 | 满足 N7；allSettled 保证单 Server 失败不阻断整体；启动时间 ≈ 最慢单 Server 连接时间 |
| risk 推断 | 关键词匹配（write/read/execute 三级，兜底 execute） | 与现有 `autoSafety.ts` 风格一致；保守兜底符合安全原则 |
