import { render, type Instance } from 'ink';
import React from 'react';

import { loadConfig, type LoadConfigOptions } from '../config/loadConfig.js';
import { createProvider } from '../providers/createProvider.js';
import { ChatSessionController } from '../session/ChatSessionController.js';
import { App } from '../tui/App.js';

export type RenderApp = (node: React.ReactNode) => Instance;

export interface BootstrapAppOptions extends LoadConfigOptions {
  fetch?: typeof fetch;
  renderApp?: RenderApp;
}

export async function bootstrapApp(options: BootstrapAppOptions = {}): Promise<Instance> {
  const { cwd, fetch, homeDir, renderApp = render } = options;
  const resolvedConfig = await loadConfig({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(homeDir !== undefined ? { homeDir } : {})
  });
  const provider = createProvider({
    config: resolvedConfig.config,
    ...(fetch !== undefined ? { fetch } : {})
  });
  const controller = new ChatSessionController({
    provider,
    config: resolvedConfig.config
  });

  return renderApp(<App controller={controller} resolvedConfig={resolvedConfig} />);
}
