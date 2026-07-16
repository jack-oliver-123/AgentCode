import { createInterface, emitKeypressEvents } from 'node:readline';

import {
  type RestoredSession,
  type SessionSummary,
  listSessions as defaultListSessions,
  loadSession as defaultLoadSession,
} from './SessionRestore.js';

export interface ResumeSelectorInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface ResumeSelectorOptions {
  input?: ResumeSelectorInput;
  output?: NodeJS.WritableStream;
  listSessions?: typeof defaultListSessions;
  loadSession?: typeof defaultLoadSession;
}

export async function pickSession(cwd: string, options: ResumeSelectorOptions = {}): Promise<RestoredSession | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const listSessions = options.listSessions ?? defaultListSessions;
  const summaries = await listSessions(cwd);

  if (summaries.length === 0) {
    output.write('没有可恢复的历史会话\n');
    return null;
  }
  if (input.isTTY !== true) {
    return null;
  }

  const selected = await selectSummary(summaries, input, output);
  if (selected === null) {
    return null;
  }
  try {
    return options.loadSession !== undefined
      ? await options.loadSession(selected.filePath)
      : await defaultLoadSession(selected.filePath, cwd);
  } catch (error) {
    console.warn(`[ResumeSelector] 无法恢复会话: ${selected.filePath}`, error);
    return null;
  }
}

export class ResumeSelector {
  constructor(private readonly options: ResumeSelectorOptions = {}) {}

  pickSession(cwd: string): Promise<RestoredSession | null> {
    return pickSession(cwd, this.options);
  }
}

async function selectSummary(
  summaries: readonly SessionSummary[],
  input: ResumeSelectorInput,
  output: NodeJS.WritableStream,
): Promise<SessionSummary | null> {
  let selectedIndex = 0;
  let digits = '';
  let settled = false;
  const previousRawMode = input.isRaw === true;
  const readline = createInterface({ input, output, terminal: true });
  emitKeypressEvents(input, readline);
  input.setRawMode?.(true);

  output.write('选择要恢复的会话（↑/↓ 或数字，Enter 确认，Esc 取消）：\n');
  for (const [index, summary] of summaries.entries()) {
    output.write(
      `${index + 1}. ${summary.sessionId}  ${formatSummaryDate(summary.lastModified)}  ${summary.messageCount} 条消息\n`,
    );
  }
  output.write(`当前选择：1. ${summaries[0]!.sessionId}`);

  return new Promise<SessionSummary | null>((resolve) => {
    const finish = (value: SessionSummary | null): void => {
      if (settled) return;
      settled = true;
      input.off('keypress', onKeypress);
      input.off('end', onEnd);
      readline.close();
      input.setRawMode?.(previousRawMode);
      output.write('\n');
      resolve(value);
    };
    const onEnd = (): void => finish(null);
    const onKeypress = (
      character: string | undefined,
      key: { name?: string; ctrl?: boolean; sequence?: string },
    ): void => {
      if ((key.ctrl === true && key.name === 'c') || key.name === 'escape' || key.name === 'q') {
        finish(null);
        return;
      }
      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + summaries.length) % summaries.length;
        digits = '';
        showSelection(output, summaries, selectedIndex);
        return;
      }
      if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % summaries.length;
        digits = '';
        showSelection(output, summaries, selectedIndex);
        return;
      }
      if (character !== undefined && /^\d$/.test(character)) {
        digits += character;
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (digits.length > 0) {
          const requested = Number.parseInt(digits, 10) - 1;
          if (requested >= 0 && requested < summaries.length) {
            selectedIndex = requested;
          }
        }
        finish(summaries[selectedIndex] ?? null);
      }
    };

    input.on('keypress', onKeypress);
    input.on('end', onEnd);
    input.resume();
  });
}

function showSelection(output: NodeJS.WritableStream, summaries: readonly SessionSummary[], selectedIndex: number): void {
  output.write(`\r当前选择：${selectedIndex + 1}. ${summaries[selectedIndex]!.sessionId}`);
}

function formatSummaryDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
