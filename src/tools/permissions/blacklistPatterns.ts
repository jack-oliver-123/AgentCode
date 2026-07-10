/**
 * 危险命令黑名单正则集合。
 * 仅用于 run_command 工具，拦截已知高危 shell 命令。
 */
export const BLACKLIST_PATTERNS: readonly RegExp[] = [
  // 常见的 rm -r/-rf / 写法；复杂参数顺序由 isRecursiveRootRemoval 处理
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?\/(\*|$|\s)/,
  // chmod 777 对系统根目录
  /\bchmod\s+777\s+\//,
  // fork bomb
  /:\(\)\s*\{.*\|.*&.*\}/,
  // mkfs 格式化命令
  /\bmkfs\b/,
  // dd 写磁盘设备
  /\bdd\s+.*if=\/dev\/(zero|random|urandom).*of=\/dev\/[sh]d/,
  // 重定向到磁盘设备
  />\s*\/dev\/[sh]d/,
  // curl/wget 管道远程执行
  /\b(curl|wget)\b.*\|\s*(bash|sh|zsh|ksh)\b/,
];

const RM_INVOCATION_PATTERN = /(?:^|[;&|]\s*|\b(?:sudo|command)\s+|\/(?:usr\/)?bin\/)rm\s+([^;&|\n]*)/gi;
const SHELL_TOKEN_PATTERN = /"[^"]*"|'[^']*'|\S+/g;

/**
 * 识别明确的递归根目录删除。这里只覆盖直接可见的普通 shell 写法，
 * 不尝试解析变量展开、alias 或 eval 等动态命令。
 */
export function isRecursiveRootRemoval(command: string): boolean {
  RM_INVOCATION_PATTERN.lastIndex = 0;

  for (const match of command.matchAll(RM_INVOCATION_PATTERN)) {
    const invocation = match[1];
    if (invocation === undefined) {
      continue;
    }

    const tokens = invocation.match(SHELL_TOKEN_PATTERN) ?? [];
    const recursive = tokens.some(isRecursiveOption);
    if (recursive && tokens.some(isRootTarget)) {
      return true;
    }
  }

  return false;
}

function isRecursiveOption(token: string): boolean {
  return token === '--recursive' || /^-[^-]*[rR]/.test(token);
}

function isRootTarget(token: string): boolean {
  if (token.startsWith('-')) {
    return false;
  }

  const unquoted = stripMatchingQuotes(token);
  return (
    /^\/+$/u.test(unquoted) ||
    /^\/+(?:\*|\{\*,\.\*\}|\.\[!\.\]\*)$/u.test(unquoted) ||
    /^\/+(?:(?:\.{1,2})\/?)+$/u.test(unquoted)
  );
}

function stripMatchingQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}
