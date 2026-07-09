import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** git 上下文信息 */
export interface GitContext {
  /** 当前分支名（detached HEAD 时为 undefined） */
  branch: string;
  /** 是否有未提交变更（无法判断时为 undefined） */
  dirty: boolean | undefined;
}

/** 缓存条目 */
interface CacheEntry {
  result: GitContext | undefined;
  timestamp: number;
}

/** 缓存 TTL：5 秒内复用上次结果 */
const CACHE_TTL_MS = 5000;

/** 按 cwd 缓存 git 上下文 */
const cache = new Map<string, CacheEntry>();

/**
 * 获取 cwd 下的 git 上下文（分支名 + dirty 状态）。
 * 不在 git 仓库中或执行失败时返回 undefined，不抛异常。
 *
 * 结果缓存 5 秒，避免每轮用户消息都阻塞式 spawn 子进程。
 */
export async function getGitContext(cwd: string): Promise<GitContext | undefined> {
  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached !== undefined && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await fetchGitContext(cwd);
  cache.set(cwd, { result, timestamp: now });
  return result;
}

/** 供测试使用：清除缓存 */
export function clearGitContextCache(): void {
  cache.clear();
}

async function fetchGitContext(cwd: string): Promise<GitContext | undefined> {
  const [branchSettled, statusSettled] = await Promise.allSettled([
    execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }),
    execFileAsync('git', ['status', '--porcelain'], { cwd, timeout: 3000 }),
  ]);

  // 分支获取失败 → 不在 git 仓库或 git 未安装
  if (branchSettled.status === 'rejected') {
    return undefined;
  }

  const branch = branchSettled.value.stdout.trim();
  // 空字符串或 detached HEAD（rev-parse 输出字面量 "HEAD"）
  if (branch.length === 0 || branch === 'HEAD') {
    return undefined;
  }

  // git status 可能超时（大仓库），此时 dirty 状态未知
  const dirty = statusSettled.status === 'fulfilled'
    ? statusSettled.value.stdout.trim().length > 0
    : undefined;

  return { branch, dirty };
}
