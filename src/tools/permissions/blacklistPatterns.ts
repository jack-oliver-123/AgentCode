/**
 * 危险命令黑名单正则集合。
 * 仅用于 run_command 工具，拦截已知高危 shell 命令。
 */
export const BLACKLIST_PATTERNS: readonly RegExp[] = [
  // rm -rf / 及变体（含 sudo、路径为 / 或 /*）
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\*|$|\s)/,
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
