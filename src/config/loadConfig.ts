import { access, lstat, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { ZodError } from 'zod';
import { parseDocument } from 'yaml';

import { AgentCodeError } from '../shared/errors.js';
import { redactText } from './redact.js';
import { normalizeConfig, parseRawConfig, type ResolvedConfig } from './schema.js';

const CONFIG_DIRECTORY = '.agentcode';
const CONFIG_FILE = 'config.yaml';

export interface LoadConfigOptions {
  cwd?: string;
  homeDir?: string;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDir = resolve(options.homeDir ?? homedir());
  const globalConfigPath = join(homeDir, CONFIG_DIRECTORY, CONFIG_FILE);
  const projectConfigPath = await findProjectConfigPath(cwd, globalConfigPath);

  if (projectConfigPath !== undefined) {
    return parseConfigFile(projectConfigPath, 'project');
  }

  if (await configPathExists(globalConfigPath)) {
    return parseConfigFile(globalConfigPath, 'global');
  }

  throw new AgentCodeError({
    code: 'config_error',
    message: `No AgentCode config found. Create ${join(CONFIG_DIRECTORY, CONFIG_FILE)} in this project or ${globalConfigPath}.`,
    retryable: false
  });
}

export async function findProjectConfigPath(
  cwd: string,
  excludedConfigPath = join(homedir(), CONFIG_DIRECTORY, CONFIG_FILE)
): Promise<string | undefined> {
  let currentDirectory = resolve(cwd);
  const root = parse(currentDirectory).root;
  const excludedPath = normalizeComparablePath(excludedConfigPath);

  while (true) {
    const configDirectory = join(currentDirectory, CONFIG_DIRECTORY);
    const candidate = join(configDirectory, CONFIG_FILE);
    if (normalizeComparablePath(candidate) !== excludedPath && (await configFileExists(configDirectory, candidate))) {
      return candidate;
    }

    if (currentDirectory === root) {
      return undefined;
    }

    currentDirectory = dirname(currentDirectory);
  }
}

async function parseConfigFile(path: string, source: ResolvedConfig['source']): Promise<ResolvedConfig> {
  const rawText = await readConfigFile(path);
  const yamlValue = parseYaml(rawText, path);
  const secrets = collectSecretCandidates(yamlValue);

  try {
    const rawConfig = parseRawConfig(yamlValue);

    return {
      source,
      path,
      config: normalizeConfig(rawConfig)
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AgentCodeError({
        code: 'config_error',
        message: redactText(`Invalid AgentCode config at ${path}: ${formatZodError(error)}`, secrets),
        retryable: false
      });
    }

    throw error;
  }
}

function parseYaml(rawText: string, path: string): unknown {
  const document = parseDocument(rawText);

  if (document.errors.length > 0) {
    throw new AgentCodeError({
      code: 'config_error',
      message: `Invalid YAML in AgentCode config at ${path}. Check the file syntax and indentation.`,
      retryable: false
    });
  }

  return document.toJSON();
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function collectSecretCandidates(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !('api_key' in value)) {
    return [];
  }

  const apiKey = (value as { api_key?: unknown }).api_key;
  return typeof apiKey === 'string' ? [apiKey] : [];
}

function normalizeComparablePath(path: string): string {
  const normalizedPath = resolve(path);
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throwConfigAccessError(path);
  }
}

async function configFileExists(configDirectory: string, configPath: string): Promise<boolean> {
  const hasConfigDirectory = await pathExists(configDirectory);
  if (!hasConfigDirectory) {
    return false;
  }

  try {
    const configDirectoryStat = await stat(configDirectory);
    if (!configDirectoryStat.isDirectory()) {
      throwConfigAccessError(configPath);
    }
  } catch (error) {
    if (error instanceof AgentCodeError) {
      throw error;
    }

    throwConfigAccessError(configPath);
  }

  return configPathExists(configPath);
}

async function configPathExists(configPath: string): Promise<boolean> {
  const hasConfigPath = await pathExists(configPath);
  if (!hasConfigPath) {
    return false;
  }

  try {
    const configPathStat = await lstat(configPath);
    if (!configPathStat.isFile()) {
      throwConfigAccessError(configPath);
    }
  } catch (error) {
    if (error instanceof AgentCodeError) {
      throw error;
    }

    throwConfigAccessError(configPath);
  }

  return true;
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throwConfigAccessError(path);
  }
}

function throwConfigAccessError(path: string): never {
  throw new AgentCodeError({
    code: 'config_error',
    message: `Cannot access AgentCode config candidate at ${path}. Check file permissions and parent directories.`,
    retryable: false
  });
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
