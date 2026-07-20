import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryManager,
  MemoryTargetChangedError,
} from '../../../src/app/memory/MemoryManager.js';
import { atomicWritePrivateFile } from '../../../src/shared/safeFs.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeMemory(root: string, entries: Array<{ title: string; file: string; summary: string; body: string }>): Promise<void> {
  const directory = join(root, '.agentcode', 'memory');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'MEMORY.md'),
    `${entries.map((entry) => `- [${entry.title}](${entry.file}) — ${entry.summary}`).join('\n')}\n`,
    'utf8',
  );
  await Promise.all(
    entries.map((entry) =>
      writeFile(
        join(directory, entry.file),
        `---\nname: ${entry.file.slice(0, -3)}\nmetadata:\n  type: project\n---\n\n${entry.body}\n`,
        'utf8',
      ),
    ),
  );
}

describe('MemoryManager', () => {
  it('lists USER/PROJECT indexes and reads frontmatter, body, and canonical path locally', async () => {
    const project = await tempRoot('agentcode-memory-project-');
    const home = await tempRoot('agentcode-memory-home-');
    await writeMemory(home, [{ title: 'Preference', file: 'preference.md', summary: 'user note', body: 'Use Chinese.' }]);
    await writeMemory(project, [{ title: 'Architecture', file: 'architecture.md', summary: 'project note', body: 'Use events.' }]);
    const manager = new MemoryManager({ cwd: project, homeDir: home, autoNotesEnabled: true });

    const snapshot = await manager.list();
    expect(snapshot.user.map((entry) => entry.filename)).toEqual(['preference.md']);
    expect(snapshot.project.map((entry) => entry.filename)).toEqual(['architecture.md']);
    expect(snapshot.status).toMatchObject({ autoNotesEnabled: true, counts: { user: 1, project: 1 } });

    const contents = await manager.read('project', 'architecture.md');
    expect(contents.frontmatter).toContain('name: architecture');
    expect(contents.body).toBe('Use events.');
    expect(contents.path).toBe(join(project, '.agentcode', 'memory', 'architecture.md'));
  });

  it('deletes the indexed file and removes only its exact index line after fingerprint confirmation', async () => {
    const project = await tempRoot('agentcode-memory-project-');
    const home = await tempRoot('agentcode-memory-home-');
    await writeMemory(project, [
      { title: 'One', file: 'one.md', summary: 'first', body: 'one' },
      { title: 'Two', file: 'two.md', summary: 'second', body: 'two' },
    ]);
    const manager = new MemoryManager({ cwd: project, homeDir: home });
    const target = await manager.prepareDelete('project', 'one.md');

    await manager.delete(target);

    await expect(readFile(join(project, '.agentcode', 'memory', 'one.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const index = await readFile(join(project, '.agentcode', 'memory', 'MEMORY.md'), 'utf8');
    expect(index).not.toContain('one.md');
    expect(index).toContain('two.md');
  });

  it('rejects a confirmation when either the note or index changes', async () => {
    const project = await tempRoot('agentcode-memory-project-');
    const home = await tempRoot('agentcode-memory-home-');
    await writeMemory(project, [{ title: 'One', file: 'one.md', summary: 'first', body: 'one' }]);
    const manager = new MemoryManager({ cwd: project, homeDir: home });
    const target = await manager.prepareDelete('project', 'one.md');
    const notePath = join(project, '.agentcode', 'memory', 'one.md');
    await writeFile(notePath, 'changed after confirmation', 'utf8');

    await expect(manager.delete(target)).rejects.toBeInstanceOf(MemoryTargetChangedError);
    expect(await readFile(notePath, 'utf8')).toBe('changed after confirmation');
    expect(await readFile(join(project, '.agentcode', 'memory', 'MEMORY.md'), 'utf8')).toContain('one.md');
  });

  it('rejects traversal entries instead of reading or deleting outside the memory root', async () => {
    const project = await tempRoot('agentcode-memory-project-');
    const home = await tempRoot('agentcode-memory-home-');
    const directory = join(project, '.agentcode', 'memory');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'MEMORY.md'), '- [Outside](../outside.md) — unsafe\n', 'utf8');
    await writeFile(join(project, '.agentcode', 'outside.md'), 'must remain', 'utf8');
    const manager = new MemoryManager({ cwd: project, homeDir: home });

    expect((await manager.list()).project).toEqual([]);
    await expect(manager.prepareDelete('project', '../outside.md')).rejects.toThrow('Unsafe memory filename');
    expect(await readFile(join(project, '.agentcode', 'outside.md'), 'utf8')).toBe('must remain');
  });

  it('restores the note and preserves the old index when atomic index persistence fails', async () => {
    const project = await tempRoot('agentcode-memory-project-');
    const home = await tempRoot('agentcode-memory-home-');
    await writeMemory(project, [{ title: 'One', file: 'one.md', summary: 'first', body: 'one' }]);
    const writeIndex = vi.fn(async () => {
      throw new Error('disk full');
    });
    const manager = new MemoryManager({ cwd: project, homeDir: home, writeIndex });
    const target = await manager.prepareDelete('project', 'one.md');

    await expect(manager.delete(target)).rejects.toThrow('disk full');

    expect(writeIndex).toHaveBeenCalledOnce();
    expect(await readFile(join(project, '.agentcode', 'memory', 'one.md'), 'utf8')).toContain('one');
    expect(await readFile(join(project, '.agentcode', 'memory', 'MEMORY.md'), 'utf8')).toContain('one.md');
  });

  it('uses the production atomic writer by default', async () => {
    const project = await tempRoot('agentcode-memory-project-');
    const home = await tempRoot('agentcode-memory-home-');
    const manager = new MemoryManager({ cwd: project, homeDir: home });

    expect(manager.writeIndex).toBe(atomicWritePrivateFile);
  });
});
