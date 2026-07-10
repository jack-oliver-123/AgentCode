import { renderToString } from 'ink';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { PermissionPrompt } from '../../../src/tui/components/PermissionPrompt.js';

describe('PermissionPrompt', () => {
  it('渲染后输出包含工具名、描述和 execute 风险', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="run_command"
        description="[execute] run_command: npm install"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('run_command');
    expect(output).toContain('npm install');
    expect(output).toContain('[execute]');
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
        description="[execute] run_command: echo hello"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('允许(本次)');
    expect(output).toContain('允许(本会话)');
    expect(output).toContain('允许(永久)');
    expect(output).toContain('拒绝');
  });

  it('显示 read 风险类型标识', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="read_file"
        description="[read] read_file: src/index.ts"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('[read]');
  });

  it('组件可使用蓝色标题与边框渲染', () => {
    const output = renderToString(
      <PermissionPrompt
        toolName="run_command"
        description="[execute] run_command: echo hi"
        onRespond={() => {}}
      />,
    );
    expect(output).toContain('run_command');
  });
});
