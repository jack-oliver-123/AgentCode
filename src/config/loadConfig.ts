import { access, chmod, lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { ZodError } from 'zod';

import { AgentCodeError } from '../shared/errors.js';
import { type McpServersConfig, mergeMcpConfigs, parseMcpServersConfig } from './mcpSchema.js';
import { redactText } from './redact.js';
import { type RawConfig, type ResolvedConfig, normalizeConfig, parseRawConfig } from './schema.js';

const CONFIG_DIRECTORY = '.agentcode';
const CONFIG_FILE = 'config.yaml';
const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const EXAMPLE_API_KEY = 'replace-with-your-api-key';
const DEFAULT_CONFIG_TEMPLATE = `protocol: anthropic
model: claude-sonnet-4-6
base_url: https://api.anthropic.com/v1
api_key: ${EXAMPLE_API_KEY}
thinking:
  enabled: false
request:
  timeout_ms: 120000
  headers: {}
ui:
  show_thinking: false
`;

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
    const resolved = await parseConfigFile(projectConfigPath, 'project');
    // F2/N6：双层 mcp_servers 合并——project 主配置已就位，额外读取 global 的 mcp_servers
    const globalMcpServers = await readMcpServersOnly(globalConfigPath);
    const projectMcpServers = resolved.config.mcpServers;
    const merged = mergeMcpConfigs(globalMcpServers, projectMcpServers);
    if (Object.keys(merged).length > 0) {
      resolved.config.mcpServers = merged;
    }
    return resolved;
  }

  if (await configPathExists(globalConfigPath)) {
    return parseConfigFile(globalConfigPath, 'global');
  }

  const createdConfigPath = await createDefaultProjectConfig(cwd);
  throw new AgentCodeError({
    code: 'config_error',
    message: `Created ${relative(cwd, createdConfigPath)}. Add your API key, then start AgentCode again.`,
    retryable: false,
  });
}

/**
 * 仅从配置文件中提取 mcp_servers 字段，不解析主配置。
 * 文件不存在或解析失败时静默返回空对象。
 */
async function readMcpServersOnly(configPath: string): Promise<McpServersConfig> {
  try {
    if (!(await configPathExists(configPath))) return {};
    const rawText = await readConfigFile(configPath);
    const yamlValue = parseYaml(rawText, configPath);
    if (typeof yamlValue !== 'object' || yamlValue === null) return {};
    const raw = (yamlValue as Record<string, unknown>)['mcp_servers'];
    return parseMcpServersConfig(raw);
  } catch {
    return {};
  }
}

export async function findProjectConfigPath(
  cwd: string,
  excludedConfigPath = join(homedir(), CONFIG_DIRECTORY, CONFIG_FILE),
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

async function createDefaultProjectConfig(cwd: string): Promise<string> {
  const configDirectory = join(cwd, CONFIG_DIRECTORY);
  const configPath = join(configDirectory, CONFIG_FILE);

  try {
    await mkdir(configDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
    const configDirectoryStat = await lstat(configDirectory);
    if (!configDirectoryStat.isDirectory() || configDirectoryStat.isSymbolicLink()) {
      throwConfigAccessError(configPath);
    }

    await chmod(configDirectory, CONFIG_DIRECTORY_MODE);
    await writeFile(configPath, DEFAULT_CONFIG_TEMPLATE, { encoding: 'utf8', flag: 'wx', mode: CONFIG_FILE_MODE });
    await chmod(configPath, CONFIG_FILE_MODE);
    return configPath;
  } catch (error) {
    if (error instanceof AgentCodeError) {
      throw error;
    }

    throwConfigAccessError(configPath);
  }
}

async function parseConfigFile(path: string, source: ResolvedConfig['source']): Promise<ResolvedConfig> {
  const rawText = await readConfigFile(path);
  const yamlValue = parseYaml(rawText, path);
  const secrets = collectSecretCandidates(yamlValue);

  try {
    const rawConfig = parseRawConfig(yamlValue);
    rejectPlaceholderApiKey(rawConfig, path);

    return {
      source,
      path,
      config: normalizeConfig(rawConfig),
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AgentCodeError({
        code: 'config_error',
        message: redactText(`Invalid AgentCode config at ${path}: ${formatZodError(error)}`, secrets),
        retryable: false,
      });
    }

    throw error;
  }
}

function rejectPlaceholderApiKey(rawConfig: RawConfig, path: string): void {
  if (rawConfig.api_key !== EXAMPLE_API_KEY) {
    return;
  }

  throw new AgentCodeError({
    code: 'config_error',
    message: `AgentCode config at ${path} still contains the example api_key. Replace it with your real API key.`,
    retryable: false,
  });
}

function parseYaml(rawText: string, path: string): unknown {
  const document = parseDocument(rawText);

  if (document.errors.length > 0) {
    throw new AgentCodeError({
      code: 'config_error',
      message: `Invalid YAML in AgentCode config at ${path}. Check the file syntax and indentation.`,
      retryable: false,
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
    retryable: false,
  });
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
  );
}
