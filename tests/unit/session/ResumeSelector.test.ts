import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { pickSession } from '../../../src/session/ResumeSelector.js';
import type { RestoredSession, SessionSummary } from '../../../src/session/SessionRestore.js';

describe('ResumeSelector', () => {
  it('数字 2 选择第二条会话，并在返回前恢复 raw mode', async () => {
    const { input, output, rawModes } = createTerminal();
    const summaries = createSummaries();
    const restored = createRestored('second');
    const loadSession = vi.fn(async () => restored);

    const selection = pickSession('/project', {
      input,
      output,
      listSessions: async () => summaries,
      loadSession,
    });
    input.write('2\n');

    await expect(selection).resolves.toBe(restored);
    expect(loadSession).toHaveBeenCalledWith('/sessions/second.jsonl');
    expect(rawModes.at(-1)).toBe(false);
  });

  it('方向键向下后 Enter 选择第二条会话', async () => {
    const { input, output } = createTerminal();
    const summaries = createSummaries();
    const restored = createRestored('second');

    const selection = pickSession('/project', {
      input,
      output,
      listSessions: async () => summaries,
      loadSession: async () => restored,
    });
    input.write('\u001b[B\r');

    await expect(selection).resolves.toBe(restored);
  });

  it('无会话时显示提示并返回 null；非 TTY 有会话时也返回 null', async () => {
    const emptyTerminal = createTerminal();
    const empty = await pickSession('/project', {
      input: emptyTerminal.input,
      output: emptyTerminal.output,
      listSessions: async () => [],
      loadSession: async () => createRestored('unused'),
    });
    expect(empty).toBeNull();
    expect(emptyTerminal.readOutput()).toContain('没有可恢复的历史会话');

    const nonTty = new PassThrough() as PassThrough & { isTTY?: boolean };
    nonTty.isTTY = false;
    await expect(
      pickSession('/project', {
        input: nonTty,
        output: new PassThrough(),
        listSessions: async () => createSummaries(),
        loadSession: async () => createRestored('unused'),
      }),
    ).resolves.toBeNull();
  });
});

function createTerminal(): {
  input: PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): typeof input };
  output: PassThrough;
  rawModes: boolean[];
  readOutput(): string;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): typeof input;
  };
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  const rawModes: boolean[] = [];
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    rawModes.push(mode);
    return input;
  };
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    input,
    output,
    rawModes,
    readOutput: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function createSummaries(): SessionSummary[] {
  return [
    { filePath: '/sessions/first.jsonl', sessionId: 'first', messageCount: 2, turnCount: 1, lastModified: new Date(1) },
    { filePath: '/sessions/second.jsonl', sessionId: 'second', messageCount: 4, turnCount: 2, lastModified: new Date(2) },
  ];
}

function createRestored(label: string): RestoredSession {
  return {
    providerContext: [{ role: 'user', content: label }],
    messages: [{ id: label, role: 'user', parts: [{ type: 'text', text: label }], createdAt: 1 }],
  };
}
