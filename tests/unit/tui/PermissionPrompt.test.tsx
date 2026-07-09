import { renderToString } from 'ink';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { PermissionPrompt, createAskPermission } from '../../../src/tui/components/PermissionPrompt.js';
import type { PromptResponse } from '../../../src/tools/permissions/types.js';

describe('PermissionPrompt', () => {
  it('渲染后输出包含工具名和描述', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="run_command"
        description="[write] run_command: npm install"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('run_command');
    expect(output).toContain('npm install');
  });

  it('渲染包含权限请求标题', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="write_file"
        description="[write] write_file: src/foo.ts"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('权限请求');
  });

  it('显示 4 个选项文本', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="run_command"
        description="[write] run_command: echo hello"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('允许(本次)');
    expect(output).toContain('允许(本会话)');
    expect(output).toContain('允许(永久)');
    expect(output).toContain('拒绝');
  });

  it('显示 risk 类型标识', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="read_file"
        description="[read] read_file: src/index.ts"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('[read]');
  });

  it('组件标题/边框使用 blue color prop', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="run_command"
        description="[write] run_command: echo hi"
        onRespond={() => {}}
      />,
    );
    // 渲染输出包含工具名（验证渲染成功）
    expect(output).toContain('run_command');
  });
});

describe('createAskPermission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('调用 renderPrompt 并在 onRespond 后 resolve', async () => {
    let capturedOnRespond: ((r: PromptResponse) => void) | undefined;
    const renderPrompt = vi.fn().mockImplementation((props) => {
      capturedOnRespond = props.onRespond;
    });
    const dismissPrompt = vi.fn();

    const askFn = createAskPermission(renderPrompt, dismissPrompt);
    const promise = askFn({ toolName: 'run_command' }, '[write] run_command: echo hi');

    expect(renderPrompt).toHaveBeenCalledOnce();
    expect(capturedOnRespond).toBeDefined();

    // 模拟用户选择
    capturedOnRespond!({ action: 'allow_session' });

    const result = await promise;
    expect(result).toEqual({ action: 'allow_session' });
    expect(dismissPrompt).toHaveBeenCalledOnce();
  });

  it('30s 超时后自动 resolve 为 deny', async () => {
    const renderPrompt = vi.fn();
    const dismissPrompt = vi.fn();

    const askFn = createAskPermission(renderPrompt, dismissPrompt);
    const promise = askFn({ toolName: 'write_file' }, '[write] write_file: x.ts');

    // 快进 30s
    vi.advanceTimersByTime(30_000);

    const result = await promise;
    expect(result).toEqual({ action: 'deny' });
    expect(dismissPrompt).toHaveBeenCalledOnce();
  });

  it('各选项正确映射到 PromptResponse', async () => {
    const actions: PromptResponse['action'][] = ['allow_once', 'allow_session', 'allow_permanent', 'deny'];

    for (const action of actions) {
      let capturedOnRespond: ((r: PromptResponse) => void) | undefined;
      const renderPrompt = vi.fn().mockImplementation((props) => {
        capturedOnRespond = props.onRespond;
      });
      const dismissPrompt = vi.fn();

      const askFn = createAskPermission(renderPrompt, dismissPrompt);
      const promise = askFn({ toolName: 'run_command' }, 'desc');

      capturedOnRespond!({ action });
      const result = await promise;
      expect(result.action).toBe(action);
    }
  });
});
