import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** git 上下文信息 */
export interface GitContext {
  /** 当前分支名 */
  branch: string;
  /** 是否有未提交变更 */
  dirty: boolean;
}

/**
 * 获取 cwd 下的 git 上下文（分支名 + dirty 状态）。
 * 不在 git 仓库中或执行失败时返回 undefined，不抛异常。
 */
export async function getGitContext(cwd: string): Promise<GitContext | undefined> {
  try {
    const [branchResult, statusResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }),
      execFileAsync('git', ['status', '--porcelain'], { cwd, timeout: 3000 }),
    ]);

    const branch = branchResult.stdout.trim();
    if (branch.length === 0) {
      return undefined;
    }

    const dirty = statusResult.stdout.trim().length > 0;
    return { branch, dirty };
  } catch {
    // 不在 git 仓库中，或 git 未安装
    return undefined;
  }
}
