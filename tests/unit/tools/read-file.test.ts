import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createReadFileTool } from '../../../src/tools/builtins/read-file.js';
import { createWorkspace, executeFileTool, writeWorkspaceFile } from './file-test-helpers.js';

const SENTINEL_SECRET = 'sk-agentcode-e2e-secret-should-not-appear';

describe('read_file', () => {
  it('reads UTF-8 text files inside the workspace', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'src/index.ts', 'hello from file');

    const result = await executeFileTool(createReadFileTool(), '{"path":"src/index.ts"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      toolName: 'read_file',
      data: {
        path: join('src', 'index.ts'),
        content: 'hello from file',
        bytes: 15,
        truncated: false
      },
      meta: {
        truncated: false
      }
    });
  });

  it('rejects paths outside the workspace', async () => {
    const workspace = await createWorkspace();

    const result = await executeFileTool(createReadFileTool(), '{"path":"../outside.txt"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace'
      }
    });
  });

  it('returns file_not_found for missing files', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'src'));

    const result = await executeFileTool(createReadFileTool(), '{"path":"src/missing.ts"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'file_not_found'
      }
    });
  });

  it('rejects non-text files', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'bin/data.bin', Buffer.from([0xff, 0x00, 0xfe]));

    const result = await executeFileTool(createReadFileTool(), '{"path":"bin/data.bin"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'file_not_text'
      }
    });
  });

  it('truncates returned content by the smaller tool and context byte limits', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'large.txt', 'abcdef');

    const result = await executeFileTool(createReadFileTool(), '{"path":"large.txt","maxBytes":4}', {
      cwd: workspace,
      maxOutputBytes: 10
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: 'abcd',
        bytes: 6,
        truncated: true
      },
      meta: {
        truncated: true
      }
    });
  });

  it('does not split multi-byte UTF-8 characters when truncating', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'unicode.txt', '猫abc');

    const result = await executeFileTool(createReadFileTool(), '{"path":"unicode.txt"}', {
      cwd: workspace,
      maxOutputBytes: 4
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: '猫a',
        truncated: true
      }
    });
  });

  it('preserves JSON file formatting when no redaction is needed', async () => {
    const workspace = await createWorkspace();
    const formattedJson = '{\n  "name": "demo",\n  "scripts": {\n    "test": "vitest"\n  }\n}\n';
    await writeWorkspaceFile(workspace, 'package.json', formattedJson);

    const result = await executeFileTool(createReadFileTool(), '{"path":"package.json"}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: formattedJson
      }
    });
  });

  it('redacts secrets before returning content through the executor', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'secret.txt', `secret=${SENTINEL_SECRET}`);

    const result = await executeFileTool(createReadFileTool(), '{"path":"secret.txt"}', {
      cwd: workspace,
      secrets: [SENTINEL_SECRET]
    });

    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET);
  });

  it('redacts full content before truncating so split secrets do not leak', async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFile(workspace, 'secret.txt', `prefix ${SENTINEL_SECRET} suffix`);

    const result = await executeFileTool(createReadFileTool(), '{"path":"secret.txt","maxBytes":12}', {
      cwd: workspace,
      secrets: [SENTINEL_SECRET]
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: 'prefix <reda',
        truncated: true
      }
    });
    expect(JSON.stringify(result)).not.toContain('sk-agentcode');
    expect(JSON.stringify(result)).not.toContain('should-not-appear');
  });

  it('rejects files reached through a directory link that resolves outside the workspace', async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'agentcode-read-outside-'));
    await writeWorkspaceFile(outside, 'secret.txt', 'secret');
    await symlink(outside, join(workspace, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await executeFileTool(createReadFileTool(), JSON.stringify({ path: join('linked-dir', 'secret.txt') }), { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'path_outside_workspace'
      }
    });
  });

  it('rejects invalid argument shapes before touching the filesystem', async () => {
    const workspace = await createWorkspace();

    const result = await executeFileTool(createReadFileTool(), '{"path":"file.txt","maxBytes":0}', { cwd: workspace });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments'
      }
    });
  });
});
