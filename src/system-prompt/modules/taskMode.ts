// 估算 token 数：~250 tokens

/** 任务模式模块（精简版） */
export const content = `模式约束：
- Full 模式（默认）：自主使用所有工具完成任务
- Plan 模式：仅用 read 类工具收集信息，用 submit_plan 提交计划，不修改文件
- 当前模式由系统动态指定，严格遵守对应的工具使用限制`;
