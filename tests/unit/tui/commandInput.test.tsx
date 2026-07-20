import { renderToString } from 'ink';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { InteractionRequest } from '../../../src/app/interaction/InteractionCoordinator.js';
import type { MemoryIndexSnapshot } from '../../../src/app/memory/MemoryManager.js';
import type { PermissionRuleView } from '../../../src/app/permissions/PermissionManager.js';
import type { WorkspaceSessionSummary } from '../../../src/app/session/SessionWorkspace.js';
import { createBuiltinCommandRegistry } from '../../../src/commands/builtins/index.js';
import { CommandCompletionService } from '../../../src/commands/completion.js';
import type { AgentConfig, ResolvedConfig } from '../../../src/config/schema.js';
import { CommandHelpPanel } from '../../../src/tui/components/CommandHelpPanel.js';
import { InputPane } from '../../../src/tui/components/InputPane.js';
import { InteractionPrompt } from '../../../src/tui/components/InteractionPrompt.js';
import { StatusBar } from '../../../src/tui/components/StatusBar.js';
import { ReviewPanel } from '../../../src/tui/components/ReviewPanel.js';

const sessions: readonly WorkspaceSessionSummary[] = [
  {
    id: 'session-a',
    name: 'Feature Work',
    createdAt: 1,
    updatedAt: 2,
    turnCount: 3,
    archivePath: '/tmp/session-a.jsonl',
    agentMode: 'plan',
    selectedPermissionMode: 'normal',
    current: true,
  },
];

const memory: MemoryIndexSnapshot = {
  user: [],
  project: [],
  status: {
    autoNotesEnabled: true,
    counts: { user: 0, project: 0 },
    indexPaths: { user: '/user/MEMORY.md', project: '/project/MEMORY.md' },
    storagePaths: { user: '/user', project: '/project' },
  },
};

const rules: readonly PermissionRuleView[] = [
  { id: 'project-rule-1', scope: 'project', rule: 'read_file', action: 'allow', fingerprint: 'abc' },
];

function createCompletion(): CommandCompletionService {
  return new CommandCompletionService(createBuiltinCommandRegistry(), {
    sessions: () => sessions,
    memory: () => memory,
    permissionRules: () => rules,
  });
}

describe('Task 10 command input UI', () => {
  it('shows all 13 canonical commands and normalizes alias searches', () => {
    const completion = createCompletion();

    expect(completion.candidates('/')).toHaveLength(13);
    expect(completion.candidates('/')).toEqual(expect.arrayContaining([
      '/help', '/compact', '/clear', '/plan', '/do', '/session', '/memory',
      '/permission', '/status', '/review', '/stop', '/steer', '/queue',
    ]));
    expect(completion.candidates('/comm')).toEqual(['/help']);
    expect(completion.candidates('/res')).toEqual(['/session']);
  });

  it('cycles multi-candidate menus and completes dynamic values without executing anything', () => {
    const completion = createCompletion();

    expect(completion.complete('/', 'next')).toMatchObject({ text: '/' });
    expect(completion.complete('/', 'next')).toMatchObject({ text: '/help ', selectedIndex: 0 });
    expect(completion.complete('/help ', 'previous')).toMatchObject({ text: '/queue ', selectedIndex: 12 });
    expect(completion.complete('/revie', 'next')).toMatchObject({ text: '/review ', selectedIndex: 0 });
    expect(completion.candidates('/resume ')).toEqual(['session-a', '"Feature Work"']);
  });

  it('keeps the composer enabled during an active run and advertises Steer/Queue keys', () => {
    const output = renderToString(
      <InputPane
        mode="plan"
        activeRun
        onRoute={vi.fn(async () => ({ kind: 'empty' as const, accepted: false as const, clearInput: false as const }))}
      />,
    );

    expect(output).toContain('plan❯');
    expect(output).toContain('Steer this run or queue the next task');
    expect(output).toContain('Enter steer');
    expect(output).toContain('Alt+Enter queue');
  });

  it('renders complete command metadata in detailed help', () => {
    const review = createBuiltinCommandRegistry().lookup('review')!;
    const output = renderToString(<CommandHelpPanel data={review.metadata} />);

    expect(output).toContain('/review');
    expect(output).toContain('Usage:');
    expect(output).toContain('Arguments:');
    expect(output).toContain('Effects:');
    expect(output).toContain('Example: /review pr 42');
    expect(output).toContain('AI: yes');
  });

  it.each([
    ['default', '[DEFAULT]'],
    ['plan', '[PLAN]'],
    ['review', '[REVIEW]'],
  ] as const)('renders %s mode plus estimated tokens and paused Queue state', (mode, label) => {
    const output = renderToString(
      <StatusBar
        resolvedConfig={resolvedConfig()}
        snapshot={{
          mode,
          runStatus: mode === 'review' ? 'streaming' : 'idle',
          model: 'test-model',
          estimatedTokens: 120,
          queueCount: 2,
          queuePaused: true,
          contextPercent: 12,
        }}
      />,
    );

    expect(output).toContain(label);
    expect(output).toContain('estimated: 120 tokens (12%)');
    expect(output).toContain('queued: 2');
    expect(output).toContain('paused');
  });

  it('renders typed confirmation and searchable session picker requests', () => {
    const confirmation: InteractionRequest = {
      id: 'interaction-1',
      createdAt: 1,
      kind: 'confirm-queue-clear',
      idempotencyKey: 'queue-clear-1',
      sessionId: 'session-a',
      operation: 'queue.clear',
      activeRunPolicy: 'immediate',
      allowedInReadonly: true,
      queueVersion: 2,
    };
    const picker: InteractionRequest = {
      id: 'interaction-2',
      createdAt: 1,
      kind: 'session-picker',
      idempotencyKey: 'picker-1',
      sessionId: 'session-a',
      operation: 'session.resume',
      activeRunPolicy: 'reject',
      allowedInReadonly: false,
      choices: sessions,
    };

    expect(renderToString(<InteractionPrompt request={confirmation} onRespond={vi.fn()} />)).toContain('Clear Queue?');
    const pickerOutput = renderToString(<InteractionPrompt request={picker} onRespond={vi.fn()} />);
    expect(pickerOutput).toContain('Resume session');
    expect(pickerOutput).toContain('Feature Work');
    expect(pickerOutput).toContain('Type to search');
  });

  it('renders Review findings without dumping the frozen diff', () => {
    const output = renderToString(<ReviewPanel data={{
      target: {
        kind: 'worktree',
        diffHash: 'a'.repeat(64),
        diff: 'SENSITIVE-FROZEN-DIFF',
      },
      findings: [],
      summary: 'No reportable findings.',
    }} />);

    expect(output).toContain('Review result');
    expect(output).toContain('No reportable findings.');
    expect(output).not.toContain('SENSITIVE-FROZEN-DIFF');
  });
});

function resolvedConfig(): ResolvedConfig {
  const config: AgentConfig = {
    protocol: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-secret',
    thinking: { enabled: false },
    request: { timeoutMs: 1_000, headers: {} },
    ui: { showThinking: false },
    permissionMode: 'normal',
    autoNotesEnabled: true,
  };
  return { source: 'project', path: '/project/.agentcode/config.yaml', config };
}
