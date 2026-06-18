import { symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGlobFilesTool } from '../../../src/tools/builtins/glob-files.js';
import { createWorkspace, executeFileTool, writeWorkspaceFile } from './file-test-helpers.js';

describe('glob_files', () => {
  it('matches workspace files with controlled glob syntax', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'index');
    await writeWorkspaceFile(workspace, 'src/app.ts', 'app');
    await writeWorkspaceFile(workspace, 'src/app.test.ts', 'test');
    await writeWorkspaceFile(workspace, 'README.md', 'readme');

    const result = await executeGlobFiles(JSON.stringify({ pattern: 'src/*.ts' }), workspace);

    expect(result).toMatchObject({
      ok: true,
      toolName: 'glob_files',
      data: {
        matches: ['src/app.test.ts', 'src/app.ts', 'src/index.ts'],
        truncated: false
      },
      meta: {
        truncated: false
      }
    });
  });

  it('supports recursive globstar and single-character matching', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/a.test.ts', 'a');
    await writeWorkspaceFile(workspace, 'src/ab.test.ts', 'ab');
    await writeWorkspaceFile(workspace, 'src/nested/b.test.ts', 'b');
    await writeWorkspaceFile(workspace, 'src/nested/b.test.js', 'b');

    const result = await executeGlobFiles(JSON.stringify({ pattern: 'src/**/?.test.ts' }), workspace);

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: ['src/a.test.ts', 'src/nested/b.test.ts'],
        truncated: false
      }
    });
  });

  it('skips noisy directories by default', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'index');
    await writeWorkspaceFile(workspace, '.git/config', 'secret');
    await writeWorkspaceFile(workspace, 'node_modules/pkg/index.ts', 'pkg');
    await writeWorkspaceFile(workspace, 'dist/index.ts', 'dist');

    const result = await executeGlobFiles(JSON.stringify({ pattern: '**/*.ts' }), workspace);

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: ['src/index.ts'],
        truncated: false
      }
    });
  });

  it('returns relative paths and marks results as truncated at the requested limit', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'a.txt', 'a');
    await writeWorkspaceFile(workspace, 'b.txt', 'b');
    await writeWorkspaceFile(workspace, 'c.txt', 'c');

    const result = await executeGlobFiles(JSON.stringify({ pattern: '*.txt', maxResults: 2 }), workspace);

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: ['a.txt', 'b.txt'],
        truncated: true
      },
      meta: {
        truncated: true
      }
    });
  });

  it('skips directory links that point outside the workspace', async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'index');
    await writeWorkspaceFile(outside, 'secret.ts', 'secret');
    await symlink(outside, join(workspace, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await executeGlobFiles(JSON.stringify({ pattern: '**/*.ts' }), workspace);

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: ['src/index.ts'],
        truncated: false
      }
    });
  });

  it('rejects unsafe glob patterns before listing files', async () => {
    const workspace = await createWorkspace();

    const result = await executeGlobFiles(JSON.stringify({ pattern: '../*.ts' }), workspace);

    expect(result).toMatchObject({
      ok: false,
      toolName: 'glob_files',
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects invalid argument shapes', async () => {
    const workspace = await createWorkspace();

    const result = await executeGlobFiles(JSON.stringify({ pattern: '**/*.ts', maxResults: 0 }), workspace);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });
});

function executeGlobFiles(argumentsText: string, cwd: string) {
  return executeFileTool(createGlobFilesTool(), argumentsText, {
    cwd,
    timeoutMs: 5000
  });
}
