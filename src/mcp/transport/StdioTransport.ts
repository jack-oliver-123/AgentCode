import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { McpTransport } from './types.js';

interface StdioServerEntry {
  command: string;
  args: string[];
  /** 已展开 ${VAR} 后的 env 键值对 */
  env: Record<string, string>;
}

/**
 * stdio 传输层。
 *
 * 启动子进程并通过 stdin/stdout 双向管道收发 JSON-RPC 消息。
 * F9 安全要求：子进程 env 只包含宿主的 PATH 和配置中显式声明的 env 键，
 * 不继承宿主进程的其他环境变量（API key、token 等凭证不会泄漏）。
 */
export function createStdioTransport(entry: StdioServerEntry): McpTransport {
  let childProcess: ChildProcess | undefined;
  let closed = false;

  // 消息队列：行读取器产出的消息，push 进来等待 messages() 消费
  const messageQueue: string[] = [];
  // 等待消息到来的 resolve 回调列表
  const waiters: Array<() => void> = [];

  function onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    messageQueue.push(trimmed);
    // 通知第一个等待者
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter();
  }

  // F9：env 白名单——只传宿主 PATH 和配置中显式声明的键
  const safeEnv: Record<string, string> = {
    ...(process.env['PATH'] !== undefined ? { PATH: process.env['PATH'] } : {}),
    ...entry.env,
  };

  childProcess = spawn(entry.command, entry.args, {
    env: safeEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // stderr 静默丢弃（不展示原始输出，符合 TUI 规范）
  childProcess.stderr?.resume();

  // 按行读取 stdout
  if (childProcess.stdout !== null) {
    const rl = createInterface({ input: childProcess.stdout, crlfDelay: Infinity });
    rl.on('line', onLine);
    rl.on('close', () => {
      closed = true;
      // 唤醒所有等待者，让 messages() 迭代器退出
      for (const waiter of waiters.splice(0)) waiter();
    });
  }

  return {
    async send(message: string): Promise<void> {
      if (closed || childProcess === undefined || childProcess.stdin === null) {
        throw new Error('StdioTransport: connection is closed');
      }
      await new Promise<void>((resolve, reject) => {
        childProcess!.stdin!.write(message + '\n', (err) => {
          if (err !== null && err !== undefined) reject(err);
          else resolve();
        });
      });
    },

    async *messages(): AsyncIterable<string> {
      while (true) {
        // 先消费队列中已有的消息
        while (messageQueue.length > 0) {
          yield messageQueue.shift()!;
        }
        // 队列空了：若 transport 已关闭则退出
        if (closed) break;
        // 等待下一条消息
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (childProcess !== undefined) {
        childProcess.kill();
        childProcess = undefined;
      }
      // 唤醒所有等待者，让 messages() 迭代器退出
      for (const waiter of waiters.splice(0)) waiter();
    },
  };
}
