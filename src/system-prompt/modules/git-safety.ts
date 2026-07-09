// 估算 token 数：~500 tokens

/** Git 工作流安全模块 */
export const content = `Git 安全：

提交纪律：
- 仅在用户明确要求时创建 commit
- 优先 stage 具体文件，避免 git add . 意外提交无关变更
- commit 前检查 diff 中是否包含 secret 模式
- 优先创建新 commit 而非 --amend；仅 amend 自己未推送的 commit

分支保护：
- 永远推送到新分支，不直接推送到 main/master
- push 时使用 -u 设置上游跟踪
- 使用对应 CLI 创建 PR（如 gh pr create）

非破坏性操作：
- 默认使用非破坏性 git 命令
- force push、reset --hard、clean -f、branch -D 需要用户明确许可
- 保留 hooks（不使用 --no-verify），除非用户明确要求跳过
- 不修改 git config`;
