import { renderToString, type Instance } from 'ink';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { bootstrapApp } from '../../../src/app/bootstrapApp.js';
import { runCli } from '../../../src/cli/main.js';
import type { AgentConfig, ResolvedConfig } from '../../../src/config/schema.js';
import { ChatSessionController } from '../../../src/session/ChatSessionController.js';
import type { ChatMessage, ChatSessionDraft } from '../../../src/session/types.js';
import { AgentCodeError } from '../../../src/shared/errors.js';
import { App } from '../../../src/tui/App.js';
import { InputPane, removeLastGrapheme } from '../../../src/tui/components/InputPane.js';
import { TranscriptPane } from '../../../src/tui/components/TranscriptPane.js';
import { FakeProvider } from '../../helpers/FakeProvider.js';
import { createTempWorkspace, writeAgentConfig } from '../../helpers/tempConfig.js';

describe('TUI App', () => {
  it('renders model, config source, cwd, status, and empty input prompt', () => {
    const controller = createController(new FakeProvider([]));

    const output = renderToString(<App controller={controller} cwd="/workspace/demo" resolvedConfig={createResolvedConfig()} />);

    expect(output).toContain('AgentCode');
    expect(output).toMatch(/model:\s*test-model/);
    expect(output).toMatch(/provider:\s*openai/);
    expect(output).toMatch(/config:\s*project/);
    expect(output).toMatch(/cwd:\s*demo/);
    expect(output).toContain('ready');
    expect(output).toContain('Ready for a new AgentCode conversation');
    expect(output).toContain('Ask AgentCode about this project');
    expect(output).toContain('Enter to send');
  });

  it('renders completed transcript from ChatSessionController state', async () => {
    const provider = new FakeProvider([
      { type: 'content.delta', delta: 'Hello from model' },
      { type: 'response.complete', finishReason: 'stop' }
    ]);
    const controller = createController(provider);
    await drain(controller.submitUserText('Hello'));

    const output = renderToString(<App controller={controller} resolvedConfig={createResolvedConfig()} />);

    expect(output).toContain('▌');
    expect(output).toContain('Hello');
    expect(output).toContain('AgentCode');
    expect(output).toContain('Hello from model');
    expect(output).not.toContain('You:');
    expect(output).not.toContain('AgentCode:');
  });

  it('disables input while a response is streaming', async () => {
    const provider = new FakeProvider([{ type: 'response.complete' }], { holdBeforeEvents: true });
    const controller = createController(provider);
    const turn = controller.submitUserText('Hello')[Symbol.asyncIterator]();
    await turn.next();

    try {
      const output = renderToString(<App controller={controller} resolvedConfig={createResolvedConfig()} />);

      expect(output).toContain('generating');
      expect(output).toContain('Waiting for model response');
      expect(output).not.toContain('Thinking');
      expect(output).toContain('Composer paused while AgentCode is generating');
    } finally {
      provider.release();
      await turn.next();
      await turn.next();
    }
  });

  it('hides thinking text by default and shows it only when enabled', () => {
    const draft: ChatSessionDraft = { id: 'draft-1', visibleText: 'visible answer', thinkingText: 'hidden reasoning', activity: { type: 'thinking' } };
    const hiddenOutput = renderToString(<TranscriptPane messages={[]} draft={draft} showThinking={false} />);
    const visibleOutput = renderToString(<TranscriptPane messages={[]} draft={draft} showThinking={true} />);

    expect(hiddenOutput).toContain('visible answer');
    expect(hiddenOutput).not.toContain('hidden reasoning');
    expect(visibleOutput).toContain('hidden reasoning');
  });

  it('does not mention thinking status when thinking text is hidden', () => {
    const draft: ChatSessionDraft = { id: 'draft-1', visibleText: '', thinkingText: 'hidden reasoning', activity: { type: 'thinking' } };

    const hiddenOutput = renderToString(<TranscriptPane messages={[]} draft={draft} showThinking={false} />);

    expect(hiddenOutput).toContain('Waiting for model response');
    expect(hiddenOutput).not.toContain('Thinking');
    expect(hiddenOutput).not.toContain('hidden reasoning');
  });

  it('renders tool activity without raw tool result details', () => {
    const draft: ChatSessionDraft = {
      id: 'draft-tool',
      visibleText: '',
      thinkingText: '',
      activity: { type: 'tool', toolName: 'read_file' }
    };

    const output = renderToString(<TranscriptPane messages={[]} draft={draft} showThinking={false} />);

    expect(output).toContain('Using read_file');
    expect(output).not.toContain('Waiting for the first token');
    expect(output).not.toContain('argumentsText');
    expect(output).not.toContain('sk-test-tui-secret');
  });

  it('keeps transcript bounded to the latest messages', () => {
    const messages = createTranscriptMessages(10);

    const output = renderToString(<TranscriptPane messages={messages} showThinking={false} />);

    expect(output).toContain('2 earlier messages hidden');
    expect(output).not.toContain('message 0');
    expect(output).toContain('message 9');
  });

  it('reserves transcript space for the active streaming draft', () => {
    const messages = createTranscriptMessages(8);

    const output = renderToString(
      <TranscriptPane messages={messages} draft={{ id: 'draft-1', visibleText: 'latest draft token', thinkingText: '', activity: { type: 'thinking' } }} showThinking={false} />
    );

    expect(output).toContain('3 earlier messages hidden');
    expect(output).not.toContain('message 0');
    expect(output).toContain('message 7');
    expect(output).toContain('latest draft token');
  });

  it('keeps the newest streaming draft text visible when truncating long output', () => {
    const output = renderToString(
      <TranscriptPane messages={[]} draft={{ id: 'draft-1', visibleText: `${'older '.repeat(220)}latest-token`, thinkingText: '', activity: { type: 'thinking' } }} showThinking={false} />
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

    expect(output).toContain('Error (provider_error): Provider failed safely');
    expect(output).toContain('You can retry by sending another message');
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

function createTranscriptMessages(length: number): ChatMessage[] {
  return Array.from({ length }, (_value, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `message ${index}` }],
    createdAt: index
  }));
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
