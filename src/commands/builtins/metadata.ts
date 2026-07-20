import type { CommandMetadata } from '../types.js';

const builtin = { type: 'builtin' } as const;

export const BUILTIN_COMMAND_METADATA: readonly CommandMetadata[] = [
  {
    name: 'help', aliases: ['commands'], summary: '查看命令列表或命令详情', category: 'general', argumentMode: 'argv',
    usage: ['/help', '/help <command-or-alias>'],
    examples: [{ invocation: '/help', description: '打开命令面板' }, { invocation: '/help review', description: '查看 review 详情' }],
    argumentHint: '[command]', execution: 'local', effects: ['ui'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'compact', aliases: ['summarize'], summary: '压缩当前会话上下文', category: 'conversation', argumentMode: 'raw',
    usage: ['/compact [instructions]'], examples: [{ invocation: '/compact', description: '使用默认策略压缩' }, { invocation: '/compact keep test evidence', description: '附加本次保留要求' }],
    argumentHint: '[instructions]', execution: 'hybrid', effects: ['session', 'model'], activeRunPolicy: 'reject', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'clear', aliases: ['new'], summary: '创建空上下文的新会话', category: 'conversation', argumentMode: 'argv',
    usage: ['/clear ["name"]'], examples: [{ invocation: '/clear', description: '创建未命名会话' }, { invocation: '/clear "next task"', description: '创建命名会话' }],
    argumentHint: '[name]', execution: 'local', effects: ['session'], activeRunPolicy: 'reject', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'plan', aliases: [], summary: '切换到 Plan 模式，可同时提交任务', category: 'mode', argumentMode: 'raw',
    usage: ['/plan [text]'], examples: [{ invocation: '/plan', description: '只切换模式' }, { invocation: '/plan design a safe migration', description: '切换并提交任务' }],
    argumentHint: '[task]', execution: 'hybrid', effects: ['mode', 'model'], activeRunPolicy: 'reject', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'do', aliases: ['default'], summary: '切换到 Default 模式，可同时提交任务', category: 'mode', argumentMode: 'raw',
    usage: ['/do [text]'], examples: [{ invocation: '/do', description: '只切换模式' }, { invocation: '/do implement the plan', description: '切换并提交任务' }],
    argumentHint: '[task]', execution: 'hybrid', effects: ['mode', 'model'], activeRunPolicy: 'reject', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'session', aliases: ['sessions', 'resume'], summary: '查看、恢复或重命名会话', category: 'conversation', argumentMode: 'argv',
    usage: ['/session', '/session current', '/session resume <id-or-name>', '/session rename <name>', '/resume [id-or-name]'],
    examples: [{ invocation: '/session', description: '打开会话选择器' }, { invocation: '/session current', description: '查看当前会话' }, { invocation: '/resume session-a', description: '恢复会话' }, { invocation: '/session rename "feature work"', description: '重命名当前会话' }],
    argumentHint: '[current|resume|rename]', execution: 'local', effects: ['ui', 'session'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'memory', aliases: ['memories'], summary: '查看或删除长期记忆', category: 'workspace', argumentMode: 'argv',
    usage: ['/memory', '/memory status', '/memory show <user|project> <entry>', '/memory delete <user|project> <entry>'],
    examples: [{ invocation: '/memory', description: '打开记忆面板' }, { invocation: '/memory status', description: '查看记忆状态' }, { invocation: '/memory show project architecture.md', description: '查看条目' }, { invocation: '/memory delete user preference.md', description: '确认后删除条目' }],
    argumentHint: '[status|show|delete]', execution: 'local', effects: ['ui', 'config'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'permission', aliases: ['permissions'], summary: '查看或调整工具权限', category: 'workspace', argumentMode: 'argv',
    usage: ['/permission', '/permission status', '/permission mode <strict|normal|auto|yolo>', '/permission rules [session|project|global]', '/permission remove <scope> <rule-id>'],
    examples: [{ invocation: '/permission', description: '打开权限面板' }, { invocation: '/permission mode auto', description: '选择权限模式' }, { invocation: '/permission rules project', description: '查看项目规则' }, { invocation: '/permission remove project project-abcd-1', description: '确认后删除规则' }],
    argumentHint: '[status|mode|rules|remove]', execution: 'local', effects: ['ui', 'config'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'status', aliases: [], summary: '打开本地运行状态面板', category: 'workspace', argumentMode: 'none',
    usage: ['/status'], examples: [{ invocation: '/status', description: '查看详细状态' }],
    execution: 'local', effects: ['ui'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'review', aliases: [], summary: '运行隔离的只读代码审查', category: 'workflow', argumentMode: 'argv',
    usage: ['/review [--focus "text"]', '/review branch <name> [--focus "text"]', '/review pr <number|url> [--focus "text"]'],
    examples: [{ invocation: '/review', description: '审查当前工作树' }, { invocation: '/review branch main --focus "security"', description: '审查分支差异' }, { invocation: '/review pr 42', description: '审查 GitHub PR' }],
    argumentHint: '[branch|pr|--focus]', execution: 'hybrid', effects: ['ui', 'model'], activeRunPolicy: 'reject', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'stop', aliases: [], summary: '停止当前运行并暂停 Queue', category: 'runtime', argumentMode: 'none',
    usage: ['/stop'], examples: [{ invocation: '/stop', description: '停止当前运行' }],
    execution: 'local', effects: ['session', 'model'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'steer', aliases: [], summary: '向当前运行追加高优先级指导', category: 'runtime', argumentMode: 'raw',
    usage: ['/steer <text>'], examples: [{ invocation: '/steer focus on the failing test', description: '追加运行中指导' }],
    argumentHint: '<text>', execution: 'local', effects: ['session', 'model'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
  {
    name: 'queue', aliases: [], summary: '管理当前会话的持久任务队列', category: 'runtime', argumentMode: 'argv',
    usage: ['/queue add <text>', '/queue list', '/queue run', '/queue remove <index>', '/queue clear'],
    examples: [{ invocation: '/queue add run regression tests', description: '添加未来 turn' }, { invocation: '/queue list', description: '查看队列' }, { invocation: '/queue run', description: '恢复 drain' }, { invocation: '/queue remove 1', description: '确认后移除' }, { invocation: '/queue clear', description: '确认后清空' }],
    argumentHint: '<add|list|run|remove|clear>', execution: 'local', effects: ['ui', 'session'], activeRunPolicy: 'immediate', hidden: false, userInvocable: true, source: builtin,
  },
];
