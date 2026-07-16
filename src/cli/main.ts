#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bootstrapApp } from '../app/bootstrapApp.js';
import { toPublicError } from '../shared/errors.js';

export interface RunCliOptions {
  bootstrap?: typeof bootstrapApp;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

export interface ParsedCliArgs {
  resumeMode: boolean;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  return {
    resumeMode: argv.some((argument) => {
      if (argument === '--resume') return true;
      const match = /^--resume=(.*)$/.exec(argument);
      if (match === null) return false;
      const value = match[1]!.toLowerCase();
      return value !== 'false' && value !== '0' && value !== 'no';
    }),
  };
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const bootstrap = options.bootstrap ?? bootstrapApp;
  const stderr = options.stderr ?? process.stderr;

  try {
    const app = await bootstrap();
    await app.waitUntilExit();
    return 0;
  } catch (error) {
    const publicError = toPublicError(error);
    stderr.write(`AgentCode failed to start (${publicError.code}): ${publicError.message}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  const { resumeMode } = parseCliArgs(process.argv.slice(2));
  process.exitCode = await runCli({
    ...(resumeMode ? { bootstrap: () => bootstrapApp({ resumeMode: true }) } : {}),
  });
}

function isCliEntrypoint(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }

  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isCliEntrypoint()) {
  void main();
}
