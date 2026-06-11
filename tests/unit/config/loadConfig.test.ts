import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/loadConfig.js';
import { AgentCodeError } from '../../../src/shared/errors.js';
import { createTempWorkspace, writeAgentConfig } from '../../helpers/tempConfig.js';

const VALID_PROJECT_CONFIG = `
protocol: anthropic
model: claude-opus-4-8
base_url: https://api.anthropic.com
api_key: sk-test-project-secret
thinking:
  enabled: true
  budget_tokens: 4096
request:
  timeout_ms: 30000
  headers:
    x-extra-routing: project-a
ui:
  show_thinking: true
`;

const VALID_GLOBAL_CONFIG = `
protocol: openai
model: gpt-4.1
base_url: https://api.openai.com/v1
api_key: sk-test-global-secret
`;

describe('loadConfig', () => {
  it('loads project .agentcode/config.yaml from an ancestor directory first', async () => {
    const workspace = await createTempWorkspace();
    const projectConfigPath = await writeAgentConfig(workspace.project, VALID_PROJECT_CONFIG);
    await writeAgentConfig(workspace.home, VALID_GLOBAL_CONFIG);

    const resolvedConfig = await loadConfig({ cwd: workspace.nestedProjectDirectory, homeDir: workspace.home });

    expect(resolvedConfig.source).toBe('project');
    expect(resolvedConfig.path).toBe(projectConfigPath);
    expect(resolvedConfig.config).toEqual({
      protocol: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-project-secret',
      thinking: {
        enabled: true,
        budgetTokens: 4096
      },
      request: {
        timeoutMs: 30000,
        headers: {
          'x-extra-routing': 'project-a'
        }
      },
      ui: {
        showThinking: true
      }
    });
  });

  it('falls back to global config when no project config exists', async () => {
    const workspace = await createTempWorkspace();
    const globalConfigPath = await writeAgentConfig(workspace.home, VALID_GLOBAL_CONFIG);

    const resolvedConfig = await loadConfig({ cwd: workspace.nestedProjectDirectory, homeDir: workspace.home });

    expect(resolvedConfig.source).toBe('global');
    expect(resolvedConfig.path).toBe(globalConfigPath);
    expect(resolvedConfig.config).toMatchObject({
      protocol: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-global-secret',
      thinking: {
        enabled: false
      },
      request: {
        timeoutMs: 120000,
        headers: {}
      },
      ui: {
        showThinking: false
      }
    });
  });

  it('keeps home config global when cwd is inside home without project config', async () => {
    const workspace = await createTempWorkspace();
    const projectInsideHome = `${workspace.home}/work/project`;
    const globalConfigPath = await writeAgentConfig(workspace.home, VALID_GLOBAL_CONFIG);

    const resolvedConfig = await loadConfig({ cwd: projectInsideHome, homeDir: workspace.home });

    expect(resolvedConfig.source).toBe('global');
    expect(resolvedConfig.path).toBe(globalConfigPath);
  });

  it('does not fall back to global config when project config exists but is invalid', async () => {
    const workspace = await createTempWorkspace();
    const sentinelKey = 'sk-test-sentinel-project-secret';
    await writeAgentConfig(
      workspace.project,
      `
protocol: anthropic
model: claude-opus-4-8
base_url: not-a-url
api_key: ${sentinelKey}
`
    );
    await writeAgentConfig(workspace.home, VALID_GLOBAL_CONFIG);

    await expect(loadConfig({ cwd: workspace.nestedProjectDirectory, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        retryable: false
      }
    });

    try {
      await loadConfig({ cwd: workspace.nestedProjectDirectory, homeDir: workspace.home });
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCodeError);
      const message = (error as AgentCodeError).publicError.message;
      expect(message).toContain('base_url');
      expect(message).not.toContain(sentinelKey);
    }
  });

  it.each([
    ['protocol', 'model: claude-opus-4-8\nbase_url: https://api.anthropic.com\napi_key: sk-test-required-secret'],
    ['model', 'protocol: anthropic\nbase_url: https://api.anthropic.com\napi_key: sk-test-required-secret'],
    ['base_url', 'protocol: anthropic\nmodel: claude-opus-4-8\napi_key: sk-test-required-secret'],
    ['api_key', 'protocol: anthropic\nmodel: claude-opus-4-8\nbase_url: https://api.anthropic.com']
  ])('rejects config missing required field %s', async (fieldName, configContent) => {
    const workspace = await createTempWorkspace();
    await writeAgentConfig(workspace.project, configContent);

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        retryable: false
      }
    });
  });

  it('rejects invalid protocol at config load time', async () => {
    const workspace = await createTempWorkspace();
    await writeAgentConfig(
      workspace.project,
      `
protocol: local
model: claude-opus-4-8
base_url: https://api.anthropic.com
api_key: sk-test-invalid-protocol-secret
`
    );

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        retryable: false
      }
    });
  });

  it.each(['file:///tmp/agentcode.sock', 'ftp://example.com/v1', 'data:text/plain,secret'])(
    'rejects non-http base_url %s before provider requests',
    async (baseUrl) => {
      const workspace = await createTempWorkspace();
      await writeAgentConfig(
        workspace.project,
        `
protocol: anthropic
model: claude-opus-4-8
base_url: ${baseUrl}
api_key: sk-test-invalid-url-secret
`
      );

      await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
        publicError: {
          code: 'config_error',
          retryable: false
        }
      });
    }
  );

  it.each(['https://proxy.example.com/v1?tenant=a', 'https://proxy.example.com/v1#fragment'])(
    'rejects base_url %s with query or hash components',
    async (baseUrl) => {
      const workspace = await createTempWorkspace();
      await writeAgentConfig(
        workspace.project,
        `
protocol: anthropic
model: claude-opus-4-8
base_url: ${baseUrl}
api_key: sk-test-query-hash-secret
`
      );

      await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
        publicError: {
          code: 'config_error',
          retryable: false
        }
      });
    }
  );

  it('does not fall back to global config when a project config candidate cannot be accessed', async () => {
    const workspace = await createTempWorkspace();
    await writeFile(join(workspace.project, '.agentcode'), 'not a directory', 'utf8');
    await writeAgentConfig(workspace.home, VALID_GLOBAL_CONFIG);

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        message: expect.stringContaining('Cannot access AgentCode config candidate'),
        retryable: false
      }
    });
  });

  it('rejects a config path that is a directory instead of a file', async () => {
    const workspace = await createTempWorkspace();
    await mkdir(join(workspace.project, '.agentcode', 'config.yaml'), { recursive: true });

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        message: expect.stringContaining('Cannot access AgentCode config candidate'),
        retryable: false
      }
    });
  });

  it('rejects a project config path that is a symlink', async () => {
    const workspace = await createTempWorkspace();
    const realConfigPath = join(workspace.home, 'real-project-config.yaml');
    await writeFile(realConfigPath, VALID_PROJECT_CONFIG, 'utf8');
    await mkdir(join(workspace.project, '.agentcode'), { recursive: true });
    await createConfigSymlink(realConfigPath, join(workspace.project, '.agentcode', 'config.yaml'));

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        message: expect.stringContaining('Cannot access AgentCode config candidate'),
        retryable: false
      }
    });
  });

  it('rejects a global config path that is a symlink', async () => {
    const workspace = await createTempWorkspace();
    const realConfigPath = join(workspace.home, 'real-global-config.yaml');
    await writeFile(realConfigPath, VALID_GLOBAL_CONFIG, 'utf8');
    await mkdir(join(workspace.home, '.agentcode'), { recursive: true });
    await createConfigSymlink(realConfigPath, join(workspace.home, '.agentcode', 'config.yaml'));

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        message: expect.stringContaining('Cannot access AgentCode config candidate'),
        retryable: false
      }
    });
  });

  it.each([
    'authorization',
    'api-key',
    'apikey',
    'x-apikey',
    'proxy-authorization',
    'x-custom-api-key',
    'x_api_key',
    'access-token',
    'x-auth-token',
    'auth-token',
    'jwt',
    'x-jwt',
    'x-auth',
    'auth',
    'authentication',
    'cookie',
    'session',
    'x-session-id',
    'credential',
    'x-credential'
  ])(
    'rejects custom auth header %s because api_key is the only auth source',
    async (headerName) => {
      const workspace = await createTempWorkspace();
      await writeAgentConfig(
        workspace.project,
        `
protocol: openai
model: gpt-4.1
base_url: https://example.com/v1
api_key: sk-test-config-secret
request:
  headers:
    ${headerName}: Bearer bypass
`
      );

      await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
        publicError: {
          code: 'config_error',
          retryable: false
        }
      });
    }
  );

  it('rejects blank api_key at config load time', async () => {
    const workspace = await createTempWorkspace();
    await writeAgentConfig(
      workspace.project,
      `
protocol: anthropic
model: claude-opus-4-8
base_url: https://api.anthropic.com
api_key: '   '
`
    );

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        retryable: false
      }
    });
  });

  it('does not leak secrets when YAML syntax is invalid', async () => {
    const workspace = await createTempWorkspace();
    const sentinelKey = 'sk-test-yaml-sentinel-secret';
    await writeAgentConfig(
      workspace.project,
      `
protocol: anthropic
model: claude-opus-4-8
base_url: https://api.anthropic.com
api_key: ${sentinelKey}
request:
  headers:
    invalid: [unterminated
`
    );

    try {
      await loadConfig({ cwd: workspace.project, homeDir: workspace.home });
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCodeError);
      const message = (error as AgentCodeError).publicError.message;
      expect(message).toContain('Invalid YAML');
      expect(message).not.toContain(sentinelKey);
    }
  });

  it('creates a project config template when config is missing', async () => {
    const workspace = await createTempWorkspace();
    const expectedConfigPath = join(workspace.nestedProjectDirectory, '.agentcode', 'config.yaml');

    await expect(loadConfig({ cwd: workspace.nestedProjectDirectory, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        message: expect.stringContaining('Add your API key'),
        retryable: false
      }
    });

    const configTemplate = await readFile(expectedConfigPath, 'utf8');
    expect(configTemplate).toContain('protocol: anthropic');
    expect(configTemplate).toContain('api_key: replace-with-your-api-key');
    await expectOwnerOnlyMode(join(workspace.nestedProjectDirectory, '.agentcode'), 0o700);
    await expectOwnerOnlyMode(expectedConfigPath, 0o600);
  });

  it('rejects the generated placeholder api key on later startup', async () => {
    const workspace = await createTempWorkspace();
    await writeAgentConfig(
      workspace.project,
      `
protocol: anthropic
model: claude-sonnet-4-6
base_url: https://api.anthropic.com/v1
api_key: replace-with-your-api-key
`
    );

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        message: expect.stringContaining('still contains the example api_key'),
        retryable: false
      }
    });
  });

  it('does not create the default config through a symlinked project config directory', async () => {
    const workspace = await createTempWorkspace();
    const symlinkTargetDirectory = join(workspace.root, 'outside-agentcode');
    const projectConfigDirectory = join(workspace.project, '.agentcode');
    await mkdir(symlinkTargetDirectory, { recursive: true });
    await createConfigSymlink(symlinkTargetDirectory, projectConfigDirectory);

    await expect(loadConfig({ cwd: workspace.project, homeDir: workspace.home })).rejects.toMatchObject({
      publicError: {
        code: 'config_error',
        message: expect.stringContaining('Cannot access AgentCode config candidate'),
        retryable: false
      }
    });
  });
});

async function expectOwnerOnlyMode(path: string, expectedMode: number): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  const actualMode = (await stat(path)).mode & 0o777;
  expect(actualMode).toBe(expectedMode);
}

async function createConfigSymlink(realConfigPath: string, linkPath: string): Promise<void> {
  try {
    await symlink(realConfigPath, linkPath);
  } catch (error) {
    if (process.platform !== 'win32' || !isNodeErrorCode(error, 'EPERM')) {
      throw error;
    }

    await symlink(realConfigPath, linkPath, 'junction');
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
