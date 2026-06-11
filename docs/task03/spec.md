# AgentCode TUI vNext Spec

## 背景

AgentCode 当前已完成 `docs/task02` 的纯对话 TUI 首版：用户可以启动终端界面、输入多轮问题、看到流式模型回复，并通过配置切换 Anthropic/OpenAI-compatible Provider。

Issue #2 的目标是让 AgentCode 的 TUI 体验继续向 Claude Code 一类终端编程助手靠近。这个目标不是一次性实现完整 Agent runtime，而是先在公开可观察行为和开源项目参考的基础上，规划并实现一轮更清晰、更可恢复、更像产品的终端对话体验。

本任务仍保持纯对话、单会话边界：不引入 tool use、文件编辑、shell execution、MCP、plugins、hooks、skills、subagents 或长期 memory。

## 参考来源

- OpenCode: 参考 terminal-first coding agent 的模式区分、规划/执行边界、子代理入口等公开产品方向；本期只吸收“模式和权限应显式呈现”的设计原则，不实现 agent mode 或 subagent。
- Crush: 参考 terminal session、command palette、权限审批、模型切换和扩展入口等公开交互方向；本期只吸收“状态、命令和权限入口需要清晰分层”的设计原则，不实现多会话、权限审批或模型切换。
- Aider: 参考命令式终端交互、repo context、git/test/fix loop 等成熟 coding workflow；本期只吸收“终端交互应可解释、可恢复、可验证”的设计原则，不实现 repo map、git workflow 或测试执行。

## 目标

- G1: 提升首屏信息架构，让用户一眼看到 AgentCode、当前模型、Provider、配置来源、工作目录和会话状态；顶部使用持续带颜色填充的小猫标识，整体采用蓝白色调。
- G2: 提升 transcript 可读性，清楚区分 user turn、assistant turn、当前 streaming draft、隐藏历史提示和错误提示。
- G3: 提升输入区反馈，让 idle、streaming、error 状态下的可操作性更明确。
- G4: 统一错误态、空态和流式态文案，使用户知道当前发生了什么、下一步能做什么。
- G5: 为未来工具调用、权限确认、命令面板、多会话等能力预留文档级 UI 槽位，但不在本期渲染假功能或接入运行时能力。
- G6: 保持 `docs/task02` 已验证的纯对话、流式、多轮上下文、密钥脱敏和范围边界不回归。

## UX 原则

- P1: 不展示虚假能力。TUI 不应出现当前不可用的按钮、快捷键或命令入口。
- P2: 状态优先于装饰。视觉改造应优先回答“现在在做什么、是否可输入、错误能否恢复”。
- P2a: 视觉风格采用蓝白色调、顶部小猫标识和横向分隔线；避免左右两侧大边框造成聊天盒子感。
- P3: 保持 keyboard-first。当前单行输入和 Enter 提交语义不变，避免本期引入复杂编辑器。
- P4: 保持会话内核稳定。TUI vNext 主要改 `src/tui/` 展示层，不应为了视觉升级改变 `ChatSessionController` 的上下文提交规则。
- P5: 可测试优先。所有“更像产品”的体验描述都应转成 render 测试、tmux capture 或 checklist 可观察项。

## 功能需求

- F1: 顶部信息区  
  TUI 应展示结构化顶部信息区，至少包含产品名、当前模型、Provider、配置来源、工作目录简短标识和会话状态。

- F2: 状态文案  
  TUI 应为 `idle`、`streaming`、`error` 提供稳定且用户可理解的文案，不只依赖原始状态枚举。

- F3: Transcript turn 分层  
  对话区应清晰区分用户消息、assistant 已完成消息和当前 assistant draft；不显示固定发言人标签，用户提示词左侧使用蓝色竖杠区分。

- F4: Streaming 可见性  
  流式回复期间，最新 assistant draft 应持续可见，并提供简短运行状态和动态效果，例如 Thinking、Writing 和生成长度提示。

- F5: 历史截断提示  
  当 transcript 只展示最近消息时，应给出稳定的隐藏历史提示，避免用户误以为上下文丢失。

- F6: 输入区反馈  
  输入区在 idle/error 状态下应明确提示可以输入；streaming 状态下应明确显示等待原因并禁用提交。

- F7: 错误展示  
  Provider/config/network/protocol 等 public error 应与 assistant 正文分离展示，并保留用户后续继续输入的路径。

- F8: 空态展示  
  新会话尚无消息时，应展示简短引导，说明用户可以直接输入问题，而不是只显示空白 transcript。

- F9: Thinking 隐藏规则  
  `ui.show_thinking=false` 时，thinking 文本不得出现在 transcript、错误、stdout/stderr 或 tmux capture 中。

- F10: 未来能力槽位文档化  
  文档应说明未来 mode strip、approval bar、command palette、session rail 可能挂载的位置，但本期不实现这些运行时能力。

## 非功能需求

- N1: 范围克制  
  本期仍是纯对话单会话 TUI，不实现工具执行、文件操作、shell、MCP、插件、长期记忆或多会话管理。

- N2: 安全不回归  
  API key、Authorization header、token 和 sentinel secret 不得泄露到 TUI、错误、stdout/stderr、tmux pane capture 或测试输出。

- N3: 跨平台终端可用  
  UI 文案和布局应避免依赖单一终端特性；在 Windows/Unix 常见终端中保持可读。

- N4: 窄终端可读  
  结构化信息区和输入区在较窄终端中应优雅降级，不能让关键状态完全不可读。

- N5: 测试稳定  
  测试应断言关键文本和行为，不依赖脆弱的完整 ANSI/布局快照。

## 不做的事

- 不实现 tool use、工具调用事件流或工具结果展示。
- 不读取、编辑或写入用户项目文件。
- 不执行 shell 命令、测试命令或 git 命令。
- 不实现 MCP、plugins、hooks、skills、subagents。
- 不实现 build/plan/general agent 模式切换。
- 不实现 session picker、多会话恢复、attached clients 或长期 memory。
- 不实现 repo map、文件树、上下文选择器、git workflow 或 test/fix loop。
- 不实现模型动态切换器或 Provider 账号管理。
- 不实现 command palette、slash command 或本地命令面；这些可以作为后续独立任务。
- 不渲染不可用按钮、假快捷键或未来能力占位控件。

## 验收标准

- AC1: 启动 TUI 后，顶部信息区可观察到产品名、model、provider、config source、cwd 简短标识和当前状态。（覆盖 F1, F2）
- AC2: 新会话空态显示简短引导，输入区显示可输入提示。（覆盖 F6, F8）
- AC3: 用户提交消息后，user turn 出现在 transcript 中；assistant streaming draft 与已完成 assistant turn 可区分。（覆盖 F3, F4）
- AC4: streaming 期间输入区禁用，并显示等待模型回复的原因。（覆盖 F2, F6）
- AC5: transcript 截断较早消息时，显示隐藏历史数量提示，且最新消息和最新 draft 保持可见。（覆盖 F5）
- AC6: Provider 返回 public error 时，错误与 assistant 正文分离展示，用户可以继续提交下一轮输入。（覆盖 F7）
- AC7: `ui.show_thinking=false` 时，thinking 文本不会出现在 TUI 可见输出或测试捕获中。（覆盖 F9, N2）
- AC8: TUI vNext 不新增任何文件读写、shell execution、tool use、MCP、plugin、hook、skill、subagent 或长期 memory 运行时入口。（覆盖 N1 和“不做的事”）
- AC9: 现有 `npm run typecheck`、`npm test`、`npm run build` 通过；如环境具备 tmux，`npm run e2e:tmux` 继续通过。（覆盖 N5）
- AC10: 失败诊断、tmux pane capture 和测试输出不包含完整 sentinel API key。（覆盖 N2）
