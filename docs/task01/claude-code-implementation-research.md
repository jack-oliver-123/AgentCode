# Claude Code 实现机制公开资料调研报告

> 生成日期：2026-06-09  
> 研究问题：Claude Code 是怎么实现的？  
> 范围：仅基于公开网络资料，区分事实、限制与谨慎推测；不编造未公开源码、system prompt、调度器或 sandbox 内部细节。

## 摘要

公开资料显示，Claude Code 更像一个带权限边界的 **agentic coding runtime**，而不是单纯聊天界面：它在终端/项目目录中读取代码、调用工具、编辑文件、运行命令或测试，并根据可观察结果继续迭代。

可公开确认的核心结构包括：

1. CLI 会话入口与自动化入口；
2. 工具调用 / agent loop；
3. 权限审批与 OS 级 Bash sandbox；
4. MCP、skills、hooks、subagents/agents、plugins 等扩展层；
5. CLAUDE.md 与 auto memory 等持久上下文机制；
6. native CLI binary 分发机制。

官方文档对功能和安全边界描述较充分，但没有公开完整源码。因此，不能从公开资料推导 Claude Code 的内部 planner、tool selection 算法、prompt assembly、上下文压缩、权限判定器或 sandbox 底层实现。社区逆向和泄露报道只能作为“公开源码有限 / 非正式线索”的旁证，不能替代官方文档。

## 研究方法

本报告来自一次 deep-research workflow，按 5 个方向并行调研：

1. 官方文档与功能架构；
2. CLI / 终端交互与权限沙箱；
3. 工具调用与 agent loop；
4. MCP / plugins / skills / hooks 扩展机制；
5. 开源线索、发布包、社区逆向或公开资料。

workflow 指标：

- 搜索方向：5 个；
- 抓取来源：26 个；
- 抽取 claims：115 条；
- 验证 claims：25 条；
- 确认 claims：23 条；
- 驳回 claims：2 条；
- 综合后主要结论：8 条；
- 子代理调用：108 次。

注意：workflow 过程中存在若干子代理未按结构化输出返回的失败记录，但最终综合阶段仍完成了来源抓取、claim 验证和结论合并。本文采用最终通过验证的结论，并显式记录限制。

## 主要结论

### 1. Claude Code 的官方定位：项目级 agentic coding 工具

**置信度：高。**

Claude Code 的官方定位是项目级 agentic coding 工具 / 环境：它可在终端中读取代码库、跨文件修改、运行命令或测试，并围绕任务持续迭代，而不是只返回聊天答案。

公开确认事实：

- 官方 overview 称 Terminal 版是可在命令行编辑文件、运行命令、管理项目的完整 CLI；
- 产品页、best-practices 和 how-it-works 文档将其描述为 agentic coding environment / system；
- 官方 agent loop 可概括为：gather context → take action → verify results；
- 官方建议给 Claude 可读的 pass/fail 信号，例如测试结果、build exit code、linter、脚本或截图。

限制：这些是能力与工作流描述，不表示 Claude Code 在任何权限、环境或任务下都能无人工监督地完成交付。

来源：

- <https://code.claude.com/docs/en/overview>
- <https://www.anthropic.com/product/claude-code>
- <https://code.claude.com/docs/en/best-practices>
- <https://code.claude.com/docs/en/how-claude-code-works>
- <https://code.claude.com/docs/en/agent-sdk/agent-loop>
- <https://code.claude.com/docs/en/tools-reference>

### 2. CLI 暴露交互、非交互与会话恢复入口

**置信度：高。**

Claude Code 的 CLI 暴露多种会话和自动化入口，包括：

- 交互 REPL：`claude`；
- 带初始提示启动：`claude "query"`；
- 非交互查询：`claude -p "query"` 或 `claude --print "query"`；
- 管道输入：`cat file | claude -p "query"`；
- 继续最近会话：`claude -c`；
- 恢复指定会话：`claude -r "<session>" "query"`。

官方 headless / programmatic 文档还将 `claude -p` 关联到 Agent SDK via CLI 的非交互用法，用于脚本、CI 和自动化场景。

限制：这些资料说明公开 CLI 行为，但不揭示内部会话存储格式、恢复机制或 agent loop 的私有实现。

来源：

- <https://code.claude.com/docs/en/cli-usage>
- <https://code.claude.com/docs/en/cli-reference>
- <https://code.claude.com/docs/en/headless>
- <https://code.claude.com/docs/en/sessions>

### 3. 工具调用 / agent loop 依赖可执行工具和可观察反馈

**置信度：高。**

Claude Code 的 agent loop 依赖工具和反馈闭环：它可以搜索 / 读取文件、编辑 / 写入文件、执行 Bash 或 PowerShell、调用 MCP 工具，并把工具结果反馈给模型继续决策。

公开确认事实：

- tools reference 列出 Read、Edit、Write、Grep、Glob、Bash、PowerShell、MCP 等工具；
- how-it-works 和 Agent SDK loop 文档展示了运行测试、读取错误、读源文件、编辑、再次运行测试的循环；
- best-practices 强调给 Claude 测试、构建、linter、脚本 diff、截图等机器可读验证信号，使它能读取结果并迭代。

限制：loop 会受 max turns、预算、权限提示、工具可用性、用户中断和上下文窗口影响。“迭代直到通过”是推荐模式和能力描述，不是终止性或正确性证明。

来源：

- <https://code.claude.com/docs/en/tools-reference>
- <https://code.claude.com/docs/en/how-claude-code-works>
- <https://code.claude.com/docs/en/agent-sdk/agent-loop>
- <https://code.claude.com/docs/en/best-practices>
- <https://code.claude.com/docs/en/permissions>

### 4. 安全边界由 CLI / runtime 权限系统执行，不由模型或 CLAUDE.md 执行

**置信度：高。**

Claude Code 的安全边界由 CLI / 运行时权限系统执行，而不是由模型或 CLAUDE.md 执行。

公开确认事实：

- permissions 文档明确说明 permission rules are enforced by Claude Code, not by the model；
- prompt 或 CLAUDE.md 只能影响模型尝试做什么，不能改变允许边界；
- 默认只读工具如文件读取 / Grep 不需审批；
- Bash 命令和文件修改默认需要审批；
- 官方列出 default、acceptEdits、plan、auto、dontAsk、bypassPermissions 等 permission modes；
- plan mode 主要用于只读探索，不编辑源码；
- bypassPermissions 会跳过大多数提示，但保留 root / home 删除等较窄 circuit breaker。

限制：部分内置只读 Bash 命令可无提示运行，allowlists、auto mode、sandbox 配置和企业 managed settings 会改变提示频率。因此应表述为“默认 / 基线行为”，而非绝对每个 Bash 调用都提示。

来源：

- <https://code.claude.com/docs/en/permissions>
- <https://code.claude.com/docs/en/permission-modes>
- <https://code.claude.com/docs/en/security>
- <https://code.claude.com/docs/en/best-practices>
- <https://www.anthropic.com/product/claude-code>

### 5. permissions 与 sandboxing 是互补安全层

**置信度：高。**

Claude Code 明确区分 permissions 与 sandboxing：

- permissions：适用于所有工具，控制工具、文件和域名访问；
- sandboxing：只约束 Bash 及其子进程，是 OS 级文件系统 / 网络限制层。

公开确认事实：

- permissions 和 sandboxing 文档将二者称为互补安全层；
- permissions 在工具运行前评估，覆盖 Bash、Read、Edit、WebFetch、MCP 等；
- sandboxing 对 Bash 命令及其子进程实施 OS-level enforcement；
- 平台支持存在差异：macOS、Linux、WSL2 支持 sandbox，native Windows 和 WSL1 不支持；
- native Windows 上若有 Git for Windows / Git Bash 可用 Bash tool，否则使用 PowerShell tool；PowerShell rollout / configuration 会影响实际默认 shell。

限制：sandbox 不是完整隔离边界，也不覆盖内置文件工具或 MCP。native Windows 用户不能把官方 Bash sandbox 视为可用安全层。

来源：

- <https://code.claude.com/docs/en/permissions>
- <https://code.claude.com/docs/en/sandboxing>
- <https://code.claude.com/docs/en/getting-started>
- <https://code.claude.com/docs/en/setup>
- <https://code.claude.com/docs/en/tools-reference>

### 6. 扩展机制：MCP、hooks、skills、subagents / agents、plugins

**置信度：高。**

Claude Code 的扩展机制由 MCP、hooks、skills、subagents / agents 和 plugins 组成；plugins 是把 skills、hooks、subagents / agents、MCP servers 等组件打包成可安装单元的分发层。

公开确认事实：

- MCP 是连接外部数据源和自定义工具的开放标准；
- 官方示例包括 Google Drive、Jira、Slack 和用户自定义工具；
- CLAUDE.md、skills 和 hooks 可用于定制 Claude Code 行为；
- hooks 可在 Claude Code 生命周期事件前后运行 shell 命令；
- hooks reference 显示 handler 类型已扩展到 HTTP、MCP、prompt、agent 等；
- plugins 可将 skills、hooks、subagents / agents、MCP servers 打包成单个可安装单元。

限制：具体 MCP server 需要单独安装、认证和授信；plugin / hook 能力在不同 Claude surfaces、版本和安全配置下可能有差异。

来源：

- <https://code.claude.com/docs/en/overview>
- <https://code.claude.com/docs/en/mcp>
- <https://modelcontextprotocol.io/introduction>
- <https://code.claude.com/docs/en/hooks-guide>
- <https://code.claude.com/docs/en/hooks>
- <https://code.claude.com/docs/en/skills>
- <https://code.claude.com/docs/en/features-overview>
- <https://code.claude.com/docs/en/plugins>
- <https://code.claude.com/docs/en/plugins-reference>
- <https://claude.com/blog/claude-code-plugins>

### 7. 持久上下文：CLAUDE.md 与 auto memory

**置信度：高。**

Claude Code 的持久上下文至少由用户维护的 CLAUDE.md 和自动写入的 auto memory 组成。

公开确认事实：

- 每个 session 是新的上下文窗口；
- CLAUDE.md files 和 auto memory 两套机制跨 session 携带知识，并在每次对话开始加载；
- CLAUDE.md 是普通 Markdown，可用于项目、个人 workflow 或组织级持久指令；
- Claude Code 从当前工作目录向上遍历发现 CLAUDE.md / CLAUDE.local.md；
- 发现的文件串接进上下文，而不是后者覆盖前者；
- auto memory 默认开启；
- 每个项目目录在 `~/.claude/projects/<project>/memory/` 下有独立 memory；
- 启动时只加载 `MEMORY.md` 前 200 行或前 25KB，以先达到者为准。

限制：CLAUDE.md 是上下文指令，不是强制配置；子目录 CLAUDE.md 可按需懒加载；auto memory 可禁用或变更目录，topic files 按需读取。

来源：

- <https://code.claude.com/docs/en/memory>
- <https://support.claude.com/en/articles/14553240-give-claude-context-claude-md-and-better-prompts>
- <https://code.claude.com/docs/en/settings>

### 8. 分发线索：native CLI binary，npm 安装已弱化 / deprecated

**置信度：中。**

公开发布包线索显示，Claude Code 以 native CLI binary 分发。npm 包通过平台 optional dependency 拉取同一原生二进制，并由 postinstall 链接；但官方完整实现源码并未作为开源项目公开。

公开确认事实：

- 官方 getting-started / installation 文档写到 npm package installs the same native binary as the standalone installer；
- npm 通过 per-platform optional dependency 拉取平台包，例如 `@anthropic-ai/claude-code-darwin-arm64`；
- 安装后的 `claude` binary 本身不通过 Node.js 运行；
- troubleshoot-install 补充 optional dependencies 被禁用时没有 JavaScript fallback；
- `--ignore-scripts` 会影响 postinstall / linking 行为；
- 官方 GitHub README 显示 npm 安装方式已被标为 deprecated，并推荐 native installer、Homebrew、WinGet；
- 媒体关于 source map 泄露的报道说明存在社区逆向 / 泄露材料，但这些不是正式开源实现。

限制：可高置信确认的是分发机制；关于内部代码结构、打包器、运行时模块边界等只能依据官方少量安装文档和低权重社区报道，不能编造。

来源：

- <https://code.claude.com/docs/en/getting-started>
- <https://code.claude.com/docs/en/troubleshoot-install>
- <https://github.com/anthropics/claude-code>
- <https://www.bleepingcomputer.com/news/artificial-intelligence/claude-code-source-code-accidentally-leaked-in-npm-package/amp/>
- <https://www.infoq.com/news/2026/04/claude-code-source-leak/>

## 概念架构图

以下是基于公开资料抽象出的 Claude Code 外部可见架构。它不是官方源码结构图，也不代表未公开内部模块划分。

```text
User / Developer
      |
      v
Claude Code CLI / Surface
  - Terminal REPL
  - print/headless mode
  - IDE / desktop / browser surfaces where supported
      |
      v
Session Runtime
  - Loads CLAUDE.md / memory context
  - Maintains conversation state
  - Presents model with task + available tools
      |
      v
Model-driven Agent Loop
  1. Gather context
  2. Select tool / action
  3. Observe result
  4. Iterate or respond
      |
      +-----------------------------+
      |                             |
      v                             v
Tool Layer                      Extension Layer
  - Read / Grep / Glob           - MCP servers
  - Edit / Write                 - Skills
  - Bash / PowerShell            - Hooks
  - WebFetch / MCP tools         - Subagents / agents
                                - Plugins
      |
      v
Permission + Sandbox Boundary
  - Permission rules enforced by runtime
  - Bash sandbox where supported
  - User approval / managed policy / allow-deny lists
      |
      v
Project Filesystem / Commands / External Services
```

## “事实”与“谨慎推测”的边界

### 可公开确认的事实

- Claude Code 是闭源或至少未公开完整实现源码的官方 CLI / coding agent 产品；
- 它通过 CLI 与项目目录交互；
- 它可以使用工具读取、搜索、修改文件，运行命令并观察结果；
- 它有权限系统，且权限由 Claude Code runtime 执行，不由模型执行；
- 它区分 permissions 和 sandboxing；
- 它支持 MCP、hooks、skills、plugins、subagents / agents 等扩展机制；
- 它加载 CLAUDE.md 与 auto memory 作为持久上下文；
- 它以 native CLI binary 为核心分发形态。

### 可以合理推测但不能当作事实的内容

这些内容可作为工程理解的“高层模型”，但公开资料不足以确认内部实现：

- 内部存在 prompt assembly / context assembly 过程，用于拼接系统指令、用户消息、CLAUDE.md、memory、工具定义和历史上下文；
- 内部存在 tool selection 与结果回灌逻辑，使模型能在多轮工具调用之间决策；
- 内部存在上下文管理、压缩或恢复策略，以处理长会话；
- auto mode 可能包含独立的风险分类或规则判断流程；
- plugins / hooks / MCP 与主 runtime 之间存在能力注册、权限协调和事件分发机制。

### 不能从公开资料推出的内容

- Claude Code 的完整源码结构；
- system prompt 具体内容；
- planner / scheduler 算法；
- tool selection 的内部策略；
- 权限判定器代码；
- sandbox 的底层实现细节；
- 上下文压缩算法；
- 各 surface 之间未公开的共享 runtime 实现细节。

## 未解问题

1. Claude Code 的闭源 agent loop 内部如何组织 planner、tool selection、prompt assembly、上下文压缩和恢复策略？公开文档只描述外部行为和 SDK loop 模型。
2. Auto mode 的安全 classifier、risk scoring 和 permission prompt 决策细节是什么？官方仅说明存在独立分类 / 安全检查和 hard deny 规则边界。
3. Plugins、hooks、MCP、skills 在不同 Claude surfaces（terminal、IDE、desktop / browser / Cowork）之间的能力差异和长期兼容性如何演进？公开资料显示已有 surface-specific 限制。
4. npm deprecated 后，各平台 native installer、Homebrew、WinGet 与企业镜像 / 离线安装的长期分发策略是否会继续变化？

## 被验证阶段驳回或不采纳的 claims

workflow 中有两条 claim 因证据票数不足或来源路径问题未被采纳：

1. “Claude Code is presented by Anthropic as an agentic coding tool available across multiple surfaces, including terminal, IDE, desktop app, and browser.”  
   - 验证票数：1-0；
   - 来源：<https://docs.anthropic.com/en/docs/claude-code/overview>。
2. “Claude Code is presented by Anthropic as an agentic coding system, not merely an autocomplete or chat interface.”  
   - 验证票数：1-0；
   - 来源：<https://www.anthropic.com/product/claude-code>。

说明：这些说法在直觉上与其他官方资料相近，但因 workflow 的验证标准要求更强证据，最终未作为独立结论保留。相关含义已被更窄、更有来源支持的结论覆盖。

## 来源清单

### 官方 / 一手资料

- <https://code.claude.com/docs/en/overview>
- <https://docs.anthropic.com/en/docs/claude-code/overview>
- <https://code.claude.com/docs/en/getting-started>
- <https://docs.anthropic.com/en/docs/claude-code/getting-started>
- <https://www.anthropic.com/product/claude-code>
- <https://www.anthropic.com/engineering/claude-code-best-practices>
- <https://code.claude.com/docs/en/best-practices>
- <https://code.claude.com/docs/en/how-claude-code-works>
- <https://code.claude.com/docs/en/tools-reference>
- <https://code.claude.com/docs/en/agent-sdk/agent-loop>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works>
- <https://code.claude.com/docs/en/cli-usage>
- <https://code.claude.com/docs/en/cli-reference>
- <https://code.claude.com/docs/en/headless>
- <https://code.claude.com/docs/en/sessions>
- <https://code.claude.com/docs/en/permissions>
- <https://code.claude.com/docs/en/permission-modes>
- <https://code.claude.com/docs/en/security>
- <https://code.claude.com/docs/en/sandboxing>
- <https://code.claude.com/docs/en/setup>
- <https://code.claude.com/docs/en/configuration>
- <https://code.claude.com/docs/en/agent-sdk/permissions>
- <https://code.claude.com/docs/en/mcp>
- <https://modelcontextprotocol.io/introduction>
- <https://code.claude.com/docs/en/hooks-guide>
- <https://code.claude.com/docs/en/hooks>
- <https://code.claude.com/docs/en/skills>
- <https://code.claude.com/docs/en/features-overview>
- <https://code.claude.com/docs/en/plugins>
- <https://code.claude.com/docs/en/plugins-reference>
- <https://code.claude.com/docs/en/slash-commands>
- <https://code.claude.com/docs/en/memory>
- <https://support.claude.com/en/articles/14553240-give-claude-context-claude-md-and-better-prompts>
- <https://code.claude.com/docs/en/settings>
- <https://code.claude.com/docs/en/troubleshoot-install>
- <https://github.com/anthropics/claude-code>
- <https://claude.com/blog/claude-code-plugins>

### 社区 / 二手资料，证据强度较低

- <https://systeminternals.dev/claude-code/agent-loop/>
- <https://agentsdesign.dev/article/claude-code-master-agent-loop/>
- <https://arxiv.org/abs/2604.14228>
- <https://github.com/anthropics/claude-code/issues/41666>
- <https://www.bleepingcomputer.com/news/artificial-intelligence/claude-code-source-code-accidentally-leaked-in-npm-package/amp/>
- <https://www.infoq.com/news/2026/04/claude-code-source-leak/>

## 结论

从公开资料看，Claude Code 的“实现方式”可以安全地理解为：

> 一个围绕 Claude 模型构建的 CLI / runtime，把项目上下文、持久记忆、工具定义、权限策略和扩展机制组织起来，让模型通过多轮工具调用完成代码任务，并用测试 / 命令 / 文件变更等反馈形成 agentic loop。

但公开资料不能支持对其内部源码、私有提示词、权限判定器、planner 或 sandbox 实现做更细粒度断言。后续如果要继续研究，应优先阅读官方文档更新、Agent SDK 示例、插件 / hooks / MCP 规范，以及合法可用的发布包元数据，而不是依赖未经验证的逆向内容。
