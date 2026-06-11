import { renderToString, type Instance } from 'ink';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { bootstrapApp } from '../../../src/app/bootstrapApp.js';
import { runCli } from '../../../src/cli/main.js';
import type { AgentConfig, ResolvedConfig } from '../../../src/config/schema.js';
import { ChatSessionController } from '../../../src/session/ChatSessionController.js';
import type { ChatMessage } from '../../../src/session/types.js';
import { AgentCodeError } from '../../../src/shared/errors.js';
import { App } from '../../../src/tui/App.js';
import { InputPane, removeLastGrapheme } from '../../../src/tui/components/InputPane.js';
import { TranscriptPane } from '../../../src/tui/components/TranscriptPane.js';
import { FakeProvider } from '../../helpers/FakeProvider.js';
import { createTempWorkspace, writeAgentConfig } from '../../helpers/tempConfig.js';

describe('TUI App', () => {
  it('renders model, config source, and empty input prompt', () => {
    const controller = createController(new FakeProvider([]));

    const output = renderToString(<App controller={controller} resolvedConfig={createResolvedConfig()} />);

    expect(output).toContain('AgentCode');
    expect(output).toMatch(/model:\s*test-model/);
    expect(output).toMatch(/provider:\s*openai/);
    expect(output).toMatch(/config:\s*project/);
    expect(output).toMatch(/status:\s*idle/);
    expect(output).toContain('Ask AgentCode');
  });

  it('renders completed transcript from ChatSessionController state', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'Hello from model' },
      { type: 'response.complete', finishReason: 'stop' }
    ]);
    const controller = createController(provider);
    await drain(controller.submitUserText('Hello'));

    const output = renderToString(<App controller={controller} resolvedConfig={createResolvedConfig()} />);

    expect(output).toContain('You');
    expect(output).toContain('Hello');
    expect(output).toContain('AgentCode');
    expect(output).toContain('Hello from model');
  });

  it('disables input while a response is streaming', async () => {
    const provider = new FakeProvider([{ type: 'response.complete' }], { holdBeforeEvents: true });
    const controller = createController(provider);
    const turn = controller.submitUserText('Hello')[Symbol.asyncIterator]();
    await turn.next();

    try {
      const output = renderToString(<App controller={controller} resolvedConfig={createResolvedConfig()} />);

      expect(output).toMatch(/status:\s*streaming/);
      expect(output).toContain('Waiting for response');
    } finally {
      provider.release();
      await turn.next();
      await turn.next();
    }
  });

  it('hides thinking text by default and shows it only when enabled', () => {
    const hiddenOutput = renderToString(
      <TranscriptPane
        messages={[]}
        draft={{ id: 'draft-1', visibleText: 'visible answer', thinkingText: 'hidden reasoning' }}
        showThinking={false}
      />
    );
    const visibleOutput = renderToString(
      <TranscriptPane
        messages={[]}
        draft={{ id: 'draft-1', visibleText: 'visible answer', thinkingText: 'hidden reasoning' }}
        showThinking={true}
      />
    );

    expect(hiddenOutput).toContain('visible answer');
    expect(hiddenOutput).not.toContain('hidden reasoning');
    expect(visibleOutput).toContain('hidden reasoning');
  });

  it('keeps transcript bounded to the latest messages', () => {
    const messages: ChatMessage[] = Array.from({ length: 10 }, (_value, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `message ${index}` }],
      createdAt: index
    }));

    const output = renderToString(<TranscriptPane messages={messages} showThinking={false} />);

    expect(output).toContain('2 earlier messages hidden');
    expect(output).not.toContain('message 0');
    expect(output).toContain('message 9');
  });

  it('keeps the newest streaming draft text visible when truncating long output', () => {
    const output = renderToString(
      <TranscriptPane messages={[]} draft={{ id: 'draft-1', visibleText: `${'older '.repeat(220)}latest-token`, thinkingText: '' }} showThinking={false} />
    );

    expect(output).toContain('latest-token');
  });

  it('removes the last grapheme instead of the last UTF-16 code unit', () => {
    expect(removeLastGrapheme('hello😀')).toBe('hello');
    expect(removeLastGrapheme('hello👨‍👩‍👧‍👦')).toBe('hello');
  });

  it('renders public errors from controller state', async () => {
    const provider = new FakeProvider([
      {
        type: 'response.error',
        error: {
          code: 'provider_error',
          message: 'Provider failed safely',
          retryable: true
        }
      }
    ]);
    const controller = createController(provider);
    await drain(controller.submitUserText('Hello'));

    const output = renderToString(<App controller={controller} resolvedConfig={createResolvedConfig()} />);

    expect(output).toContain('Error: Provider failed safely');
  });
});

describe('bootstrapApp', () => {
  it.each(['openai', 'anthropic'] as const)('loads %s config and renders the app', async (protocol) => {
    const workspace = await createTempWorkspace();
    await writeAgentConfig(
      workspace.project,
      `
protocol: ${protocol}
model: ${protocol === 'openai' ? 'gpt-4.1' : 'claude-opus-4-8'}
base_url: ${protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
api_key: sk-test-bootstrap-secret
`
    );
    let renderedNode: React.ReactNode | undefined;

    const app = await bootstrapApp({
      cwd: workspace.project,
      homeDir: workspace.home,
      renderApp: (node) => {
        renderedNode = node;
        return createFakeInkInstance();
      }
    });

    expect(app).toBeDefined();
    expect(React.isValidElement(renderedNode)).toBe(true);
    if (React.isValidElement<{ resolvedConfig: ResolvedConfig }>(renderedNode)) {
      expect(renderedNode.props.resolvedConfig.config.protocol).toBe(protocol);
      expect(renderedNode.props.resolvedConfig.source).toBe('project');
    }
  });
});

describe('runCli', () => {
  it('returns a safe non-zero exit code when bootstrap fails', async () => {
    const stderrChunks: string[] = [];
    const exitCode = await runCli({
      bootstrap: async () => {
        throw new AgentCodeError({
          code: 'config_error',
          message: 'bad api_key=sk-test-cli-secret',
          retryable: false
        });
      },
      stderr: createCapturingStderr(stderrChunks)
    });

    const stderr = stderrChunks.join('');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('AgentCode failed to start (config_error)');
    expect(stderr).not.toContain('sk-test-cli-secret');
    expect(stderr).toContain('<redacted>');
  });

  it('redacts JSON-shaped secrets from unexpected startup errors', async () => {
    const stderrChunks: string[] = [];
    const exitCode = await runCli({
      bootstrap: async () => {
        throw new Error('{"api_key":"plain-secret-123","authorization":"Digest foo, response=secret-digest-value"}');
      },
      stderr: createCapturingStderr(stderrChunks)
    });

    const stderr = stderrChunks.join('');
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain('plain-secret-123');
    expect(stderr).not.toContain('secret-digest-value');
    expect(stderr).toContain('<redacted>');
  });
});

function createCapturingStderr(chunks: string[]): Pick<NodeJS.WriteStream, 'write'> {
  return {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(String(chunk));
      return true;
    }
  };
}

function createFakeInkInstance(): Instance {
  return {
    rerender: () => undefined,
    unmount: () => undefined,
    waitUntilExit: async () => undefined,
    cleanup: () => undefined,
    clear: () => undefined
  };
}

function createController(provider: FakeProvider, configOverrides: Partial<AgentConfig> = {}): ChatSessionController {
  let idCounter = 0;
  return new ChatSessionController({
    provider,
    config: createConfig(configOverrides),
    createId: (prefix) => `${prefix}-${++idCounter}`,
    now: () => 1234
  });
}

function createResolvedConfig(configOverrides: Partial<AgentConfig> = {}): ResolvedConfig {
  return {
    source: 'project',
    path: '/project/.agentcode/config.yaml',
    config: createConfig(configOverrides)
  };
}

function createConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    protocol: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test-tui-secret',
    thinking: {
      enabled: false
    },
    request: {
      timeoutMs: 1000,
      headers: {}
    },
    ui: {
      showThinking: false
    },
    ...overrides
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain all state updates.
  }
}
