import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEditFileTool } from '../../../src/tools/builtins/edit-file.js';
import { createWorkspace, executeFileTool, readWorkspaceFile, writeWorkspaceFile } from './file-test-helpers.js';

describe('edit_file', () => {
  it('replaces text when oldText appears exactly once', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'const name = "old";\n');

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: 'src/index.ts', oldText: '"old"', newText: '"new"' }),
      { cwd: workspace },
    );

    expect(result).toMatchObject({
      ok: true,
      toolName: 'edit_file',
      data: {
        path: join('src', 'index.ts'),
        replacements: 1,
      },
    });
    await expect(readWorkspaceFile(workspace, 'src/index.ts')).resolves.toBe('const name = "new";\n');
  });

  it('returns file_not_found when the target file does not exist', async () => {
    const workspace = await createWorkspace();

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: 'missing.txt', oldText: 'old', newText: 'new' }),
      { cwd: workspace },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'file_not_found',
      },
    });
  });

  it('rejects non-text files without modifying them', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'bin/data.bin', Buffer.from([0xff, 0x00, 0xfe]));

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: 'bin/data.bin', oldText: 'old', newText: 'new' }),
      { cwd: workspace },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'file_not_text',
      },
    });
    await expect(readFile(join(workspace, 'bin', 'data.bin'))).resolves.toEqual(Buffer.from([0xff, 0x00, 0xfe]));
  });

  it('does not modify the file when oldText is not found', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'const name = "current";\n');

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: 'src/index.ts', oldText: 'missing', newText: 'new' }),
      { cwd: workspace },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'not_unique_match',
        details: {
          matches: 0,
        },
      },
    });
    await expect(readWorkspaceFile(workspace, 'src/index.ts')).resolves.toBe('const name = "current";\n');
  });

  it('does not modify the file when oldText appears multiple times', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'repeat\nrepeat\n');

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: 'src/index.ts', oldText: 'repeat', newText: 'once' }),
      { cwd: workspace },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'not_unique_match',
        details: {
          matches: 2,
        },
      },
    });
    await expect(readWorkspaceFile(workspace, 'src/index.ts')).resolves.toBe('repeat\nrepeat\n');
  });

  it('rejects paths outside the workspace without modifying files', async () => {
    const workspace = await createWorkspace();
    const outside = join(workspace, '..', 'outside-edit.txt');
    await writeWorkspaceFile(join(workspace, '..'), 'outside-edit.txt', 'old');

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: '../outside-edit.txt', oldText: 'old', newText: 'new' }),
      { cwd: workspace },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
    await expect(readFile(outside, 'utf8')).resolves.toBe('old');
  });

  it('rejects edits through a workspace directory link that resolves outside', async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-edit-outside-'));
    await writeWorkspaceFile(outside, 'secret.txt', 'old');
    await symlink(outside, join(workspace, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: join('linked-dir', 'secret.txt'), oldText: 'old', newText: 'new' }),
      { cwd: workspace },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('old');
  });

  it('rejects invalid argument shapes before modifying the file', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'old');

    const result = await executeFileTool(
      createEditFileTool(),
      JSON.stringify({ path: 'src/index.ts', oldText: '', newText: 'new' }),
      {
        cwd: workspace,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments',
      },
    });
    await expect(readWorkspaceFile(workspace, 'src/index.ts')).resolves.toBe('old');
  });
});
