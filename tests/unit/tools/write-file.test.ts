import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createWriteFileTool } from '../../../src/tools/builtins/write-file.js';
import { createWorkspace, executeFileTool, readWorkspaceFile, writeWorkspaceFile } from './file-test-helpers.js';

describe('write_file', () => {
  it('writes new UTF-8 files inside the workspace', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'src'));

    const result = await executeFileTool(createWriteFileTool(), '{"path":"src/new.ts","content":"hello"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      toolName: 'write_file',
      data: {
        path: join('src', 'new.ts'),
        bytes: 5,
        overwritten: false
      }
    });
    await expect(readWorkspaceFile(workspace, 'src/new.ts')).resolves.toBe('hello');
  });

  it('rejects paths outside the workspace without writing', async () => {
    const workspace = await createWorkspace();
    const outsidePath = join(workspace, '..', 'outside-write.txt');

    const result = await executeFileTool(createWriteFileTool(), JSON.stringify({ path: '../outside-write.txt', content: 'secret' }), {
      cwd: workspace
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace'
      }
    });
    await expect(readFile(outsidePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite existing files unless overwrite is true', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'existing.txt', 'original');

    const result = await executeFileTool(createWriteFileTool(), '{"path":"existing.txt","content":"replacement"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments',
        retryable: true
      }
    });
    await expect(readWorkspaceFile(workspace, 'existing.txt')).resolves.toBe('original');
  });

  it('overwrites existing files when explicitly requested', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'existing.txt', 'original');

    const result = await executeFileTool(
      createWriteFileTool(),
      '{"path":"existing.txt","content":"replacement","overwrite":true}',
      { cwd: workspace }
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: 'existing.txt',
        bytes: 11,
        overwritten: true
      }
    });
    await expect(readWorkspaceFile(workspace, 'existing.txt')).resolves.toBe('replacement');
  });

  it('returns structured errors when the parent path is a file', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'not-a-dir', 'content');

    const result = await executeFileTool(createWriteFileTool(), '{"path":"not-a-dir/new.txt","content":"hello"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      toolName: 'write_file',
      error: {
        code: 'invalid_arguments'
      }
    });
  });

  it('rejects invalid argument shapes before writing', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'src'));

    const result = await executeFileTool(createWriteFileTool(), '{"path":"src/new.ts","content":42}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
    await expect(readFile(join(workspace, 'src', 'new.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects writes through a workspace directory link that resolves outside', async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-write-outside-'));
    await symlink(outside, join(workspace, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await executeFileTool(
      createWriteFileTool(),
      JSON.stringify({ path: join('linked-dir', 'secret.txt'), content: 'secret' }),
      { cwd: workspace }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace'
      }
    });
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
