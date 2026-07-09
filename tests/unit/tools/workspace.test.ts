import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveWorkspacePath } from '../../../src/tools/workspace.js';

describe('resolveWorkspacePath', () => {
  it('resolves workspace-relative paths', async () => {
    const workspace = await createWorkspace();
    const filePath = join(workspace, 'src', 'index.ts');
    await mkdir(join(workspace, 'src'));
    await writeFile(filePath, 'hello', 'utf8');

    const result = await resolveWorkspacePath(workspace, 'src/index.ts');

    expect(result).toMatchObject({
      ok: true,
      absolutePath: filePath,
      relativePath: join('src', 'index.ts'),
    });
  });

  it('rejects relative paths outside the workspace', async () => {
    const workspace = await createWorkspace();

    const result = await resolveWorkspacePath(workspace, '../outside.txt');

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
  });

  it('rejects absolute paths outside the workspace', async () => {
    const workspace = await createWorkspace();
    const outsidePath = resolve(workspace, '..', 'outside.txt');

    const result = await resolveWorkspacePath(workspace, outsidePath);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
  });

  it.skipIf(process.platform === 'win32')('rejects existing symlinks that resolve outside the workspace', async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-outside-'));
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'secret', 'utf8');
    const linkPath = join(workspace, 'linked-secret.txt');
    await symlink(outsideFile, linkPath);

    const result = await resolveWorkspacePath(workspace, 'linked-secret.txt');

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
  });

  it('rejects existing files reached through a workspace directory link that resolves outside', async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-outside-existing-'));
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    const linkPath = join(workspace, 'linked-existing-dir');
    await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await resolveWorkspacePath(workspace, join('linked-existing-dir', 'secret.txt'));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
  });

  it.skipIf(process.platform === 'win32')('rejects broken symlinks instead of treating them as new files', async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-broken-link-target-'));
    const linkPath = join(workspace, 'broken-linked-secret.txt');
    await symlink(join(outside, 'missing-secret.txt'), linkPath);

    const result = await resolveWorkspacePath(workspace, 'broken-linked-secret.txt');

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
  });

  it('rejects new files whose parent resolves outside the workspace', async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-outside-parent-'));
    const linkPath = join(workspace, 'linked-dir');
    await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await resolveWorkspacePath(workspace, join('linked-dir', 'new-file.txt'));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
  });

  it('rejects absolute symlink aliases that start outside the workspace even when they resolve inside', async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, 'inside.txt'), 'hello', 'utf8');
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-outside-alias-'));
    const linkPath = join(outside, 'workspace-alias');
    await symlink(workspace, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await resolveWorkspacePath(workspace, join(linkPath, 'inside.txt'));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace',
      },
    });
  });

  it('allows new files whose parent stays inside the workspace', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'src'));

    const result = await resolveWorkspacePath(workspace, 'src/new-file.ts');

    expect(result).toMatchObject({
      ok: true,
      absolutePath: join(await realpath(workspace), 'src', 'new-file.ts'),
      relativePath: join('src', 'new-file.ts'),
    });
  });

  it.skipIf(process.platform !== 'win32')('accepts Windows path separators inside the workspace', async () => {
    const workspace = await createWorkspace();
    const srcDirectory = join(workspace, 'src');
    await mkdir(srcDirectory);
    await writeFile(join(srcDirectory, 'index.ts'), 'hello', 'utf8');

    const result = await resolveWorkspacePath(workspace, 'src\\index.ts');

    expect(result).toMatchObject({
      ok: true,
      relativePath: join('src', 'index.ts'),
    });
  });

  it.skipIf(process.platform !== 'win32')('compares Windows paths case-insensitively', async () => {
    const workspace = await createWorkspace();
    const srcDirectory = join(workspace, 'src');
    await mkdir(srcDirectory);
    await writeFile(join(srcDirectory, 'index.ts'), 'hello', 'utf8');

    const result = await resolveWorkspacePath(
      workspace.toUpperCase(),
      join(workspace.toLowerCase(), 'src', 'index.ts'),
    );

    expect(result).toMatchObject({
      ok: true,
      relativePath: join('src', 'index.ts'),
    });
  });
});

async function createWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'agentcode-workspace-')));
}
