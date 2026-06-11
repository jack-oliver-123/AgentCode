#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bootstrapApp } from '../app/bootstrapApp.js';
import { toPublicError } from '../shared/errors.js';

export interface RunCliOptions {
  bootstrap?: typeof bootstrapApp;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
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
  process.exitCode = await runCli();
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
