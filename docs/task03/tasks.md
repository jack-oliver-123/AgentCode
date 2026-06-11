# AgentCode TUI vNext Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `docs/task03/spec.md` | TUI vNext 目标、范围、非目标和验收标准 |
| 新建 | `docs/task03/plan.md` | 方案选择、开源参考取舍、组件边界、风险与回滚 |
| 新建 | `docs/task03/tasks.md` | 后续实现任务拆解 |
| 新建 | `docs/task03/checklist.md` | TUI vNext 验收清单和最终验证记录 |
| 修改 | `src/tui/App.tsx` | 组合 Header/Transcript/Notice/Composer，保持会话桥接简单 |
| 修改 | `src/tui/components/StatusBar.tsx` | 顶部状态区结构化展示 |
| 修改 | `src/tui/components/TranscriptPane.tsx` | 空态、turn 分层、draft、hidden count 展示 |
| 可选新建 | `src/tui/components/NoticeBar.tsx` | public error / notice 独立展示 |
| 修改 | `src/tui/components/InputPane.tsx` | composer 输入提示、disabled reason、状态反馈 |
| 修改 | `tests/integration/cli/cli.test.tsx` | TUI render 集成测试 |
| 修改 | `tests/e2e/tmux/agentcode-smoke.sh` | 如需要，补充 TUI vNext 可见行为断言 |

## T1: 冻结 task03 文档

**文件：** `docs/task03/spec.md`, `docs/task03/plan.md`, `docs/task03/tasks.md`, `docs/task03/checklist.md`

**依赖：** Issue #2 调研结论、`docs/task02` 已实现范围

**步骤：**
1. 在 spec 中明确本期是纯对话单会话 TUI vNext。
2. 在 spec 中列出目标、非目标、功能需求、非功能需求和验收标准。
3. 在 plan 中记录 OpenCode、Crush、Aider 的可借鉴点与本期不做项。
4. 在 plan 中明确采用“展示层升级 + 会话内核保持稳定”的方案。
5. 在 tasks 中拆分后续编码阶段。
6. 在 checklist 中定义可观察、可测试的验收项。

**验证：**
- 人工检查文档不承诺 tool use、shell execution、MCP、plugin、hook、skill、subagent 或长期 memory。
- 人工检查验收标准可以通过现有测试体系或 tmux capture 验证。

## T2: 增强 Header/Status 信息区

**文件：** `src/tui/components/StatusBar.tsx`, `src/tui/App.tsx`, `tests/integration/cli/cli.test.tsx`

**依赖：** T1

**步骤：**
1. 将顶部状态从单行拼接升级为结构化信息区。
2. 展示产品名、model、provider、config source、cwd 简短标识和会话状态。
3. 将内部状态枚举映射为用户可理解的 label，例如 ready/generating/needs attention。
4. 保持窄终端下关键字段仍可读。
5. 更新 TUI render 测试，断言关键字段出现。

**验证：**
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`。
- 运行 `npm run typecheck`。

## T3: 增强 Transcript 展示

**文件：** `src/tui/components/TranscriptPane.tsx`, `tests/integration/cli/cli.test.tsx`

**依赖：** T1

**步骤：**
1. 为新会话增加空态引导。
2. 明确区分 user turn、assistant completed turn 和 assistant draft。
3. streaming draft 保持最新内容可见，并展示正在生成提示。
4. 保留历史截断策略，优化 hidden count 文案。
5. 确保 thinking 仍只在 `showThinking=true` 时显示。

**验证：**
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`。
- 覆盖空态、completed transcript、streaming draft、hidden count、thinking hidden。

## T4: 分离 Notice/Error 展示

**文件：** `src/tui/App.tsx`, 可选 `src/tui/components/NoticeBar.tsx`, `tests/integration/cli/cli.test.tsx`

**依赖：** T1, T3

**步骤：**
1. 将 App 中的内联 error block 收敛为独立 notice/error 展示。
2. 展示 public error message，并可选展示 error code/retryable hint。
3. 确保 error 不被当成 assistant 正文。
4. 保留用户继续输入下一轮的路径。
5. 不展示原始 provider JSON、配置对象或 secret。

**验证：**
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`。
- 使用现有 error 测试确认 public error 可见且 secret 不泄露。

## T5: 增强 Composer/InputPane

**文件：** `src/tui/components/InputPane.tsx`, `tests/integration/cli/cli.test.tsx`

**依赖：** T1

**步骤：**
1. 优化 idle 状态 placeholder 和操作提示。
2. streaming 状态显示禁用原因，例如等待模型回复。
3. error 状态仍允许用户继续输入。
4. 保持 Enter 提交、backspace/delete 删除 grapheme 的现有行为。
5. 不实现多行编辑器、命令历史或 slash command 解析。

**验证：**
- 运行 `npm test -- tests/integration/cli/cli.test.tsx`。
- 确认 `removeLastGrapheme` 测试继续通过。

## T6: tmux E2E 补充观察点

**文件：** `tests/e2e/tmux/agentcode-smoke.sh`

**依赖：** T2-T5

**步骤：**
1. 保留现有 package tarball 安装、真实 `agentcode` bin 启动、两轮对话和 secret 不泄露检查。
2. 如文案稳定，补充顶部状态区或 composer 等关键文本的 pane 断言。
3. 保留 partial streaming 检查，确保 TUI vNext 没有把流式回复变成一次性展示。
4. 如果 tmux 不可用，明确记录环境阻塞，不标记 E2E 通过。

**验证：**
- 运行 `npm run e2e:tmux`。

## T7: 最终验证和文档记录

**文件：** `docs/task03/checklist.md`

**依赖：** T2-T6

**步骤：**
1. 运行 `npm run typecheck`。
2. 运行 `npm test`。
3. 运行 `npm run build`。
4. 在环境具备 tmux 时运行 `npm run e2e:tmux`。
5. 在 checklist 中记录实际验证结果、关键证据和未覆盖风险。
6. 确认没有新增 tool use、shell execution、MCP、plugin、hook、skill、subagent 或长期 memory 运行时入口。

**验证：**
- 所有已存在自动化检查通过。
- checklist 最终验收记录完整。
