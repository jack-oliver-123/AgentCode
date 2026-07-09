import { type Instance, render } from 'ink';
import type React from 'react';

import { type LoadConfigOptions, loadConfig } from '../config/loadConfig.js';
import { createProvider } from '../providers/createProvider.js';
import { ChatSessionController } from '../session/ChatSessionController.js';
import { loadDynamicModules } from '../system-prompt/index.js';
import { createDefaultToolRegistry } from '../tools/registry.js';
import { App } from '../tui/App.js';

export type RenderApp = (node: React.ReactNode) => Instance;

export interface BootstrapAppOptions extends LoadConfigOptions {
  fetch?: typeof fetch;
  renderApp?: RenderApp;
}

export async function bootstrapApp(options: BootstrapAppOptions = {}): Promise<Instance> {
  const { cwd, fetch, homeDir, renderApp = render } = options;
  const runtimeCwd = cwd ?? process.cwd();
  const resolvedConfig = await loadConfig({
    cwd: runtimeCwd,
    ...(homeDir !== undefined ? { homeDir } : {}),
  });
  const provider = createProvider({
    config: resolvedConfig.config,
    ...(fetch !== undefined ? { fetch } : {}),
  });

  // 加载动态模块（project-context + custom-instructions + memory）
  const systemPromptRegistry = await loadDynamicModules(runtimeCwd);

  const controller = new ChatSessionController({
    provider,
    config: resolvedConfig.config,
    toolRegistry: createDefaultToolRegistry(),
    cwd: runtimeCwd,
    toolTimeoutMs: resolvedConfig.config.request.timeoutMs,
    systemPromptRegistry,
  });

  return renderApp(<App controller={controller} resolvedConfig={resolvedConfig} cwd={runtimeCwd} />);
}
