// 估算 token 数：~150 tokens

/** 工具使用规范模块（精简版：只保留全局策略，per-tool 指南移入 tool descriptions） */
export const content = `工具使用：
- 优先用专用工具（read_file/edit_file/glob_files/search_code），run_command 是最后手段
- 文件路径使用绝对路径，必须在 workspace 范围内
- 无依赖的工具调用并行发起，有依赖的顺序等待结果`;
