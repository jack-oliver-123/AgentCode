// 估算 token 数：~550 tokens

/** 工具使用规范模块 */
export const content = `工具使用规范：

选择优先级：
- 优先使用专用工具完成任务，而非 run_command
- 读取文件内容用 read_file，不要用 cat/head/tail 命令
- 编辑文件用 edit_file，不要用 sed/awk 命令
- 搜索文件用 glob_files，不要用 find/ls 命令
- 搜索代码内容用 search_code，不要用 grep 命令
- 只有当专用工具无法满足需求时，才使用 run_command

并行执行：
- 无依赖关系的工具调用应并行发起
- 有依赖关系的调用必须顺序等待结果后再继续
- 例如：读取 3 个文件可以并行；读取文件后再编辑必须顺序

编辑前必须先读：
- 调用 edit_file 前，必须先用 read_file 读取目标文件
- 确保了解文件的当前内容和结构
- edit_file 的匹配文本必须与文件中的实际内容完全一致

write_file 仅用于新建：
- write_file 用于创建尚不存在的新文件
- 修改已有文件必须使用 edit_file
- 不要用 write_file 覆盖已有文件

工具参数格式：
- 文件路径使用绝对路径
- 路径必须在 workspace 范围内
- 命令参数正确转义特殊字符`;
