import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempWorkspace {
  root: string;
  home: string;
  project: string;
  nestedProjectDirectory: string;
}

export async function createTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'agentcode-config-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const nestedProjectDirectory = join(project, 'packages', 'demo');

  await mkdir(home, { recursive: true });
  await mkdir(nestedProjectDirectory, { recursive: true });

  return { root, home, project, nestedProjectDirectory };
}

export async function writeAgentConfig(directory: string, content: string): Promise<string> {
  const configDirectory = join(directory, '.agentcode');
  const configPath = join(configDirectory, 'config.yaml');

  await mkdir(configDirectory, { recursive: true });
  await writeFile(configPath, content, 'utf8');

  return configPath;
}
