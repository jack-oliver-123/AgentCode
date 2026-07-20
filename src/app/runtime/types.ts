import type { PublicError } from '../../shared/errors.js';

export type AgentMode = 'default' | 'plan';
export type PermissionMode = 'strict' | 'normal' | 'auto' | 'yolo';
export type EffectivePermissionMode = 'readonly' | PermissionMode;
export type RunPhase = 'idle' | 'streaming' | 'tool_running' | 'awaiting_permission' | 'retry_backoff';

export interface NoticeDescriptor {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  ttlMs?: number;
}

export interface PanelDescriptor {
  id: string;
  kind: 'help' | 'status' | 'session' | 'memory' | 'permission' | 'review' | 'custom';
  title: string;
  data: unknown;
}

export interface InteractionDescriptor {
  id: string;
  kind: string;
  data: unknown;
}

export interface CommandOutput {
  id: string;
  command: string;
  content: string;
  createdAt: number;
}

export interface CommandErrorSnapshot {
  code: string;
  message: string;
  at: number;
}

export interface SessionSnapshot {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  resumed: boolean;
  agentMode: AgentMode;
  selectedPermissionMode: PermissionMode;
  archivePath: string;
}

export interface RunSnapshot {
  id?: string;
  phase: RunPhase;
  reviewActive: boolean;
}

export interface QueueSnapshot {
  count: number;
  paused: boolean;
  draining: boolean;
  version: number;
}

export interface PermissionSnapshot {
  selectedMode: PermissionMode;
  effectiveMode: EffectivePermissionMode;
  generation: number;
  counts: { session: number; project: number; global: number };
}

export interface AuditEvent {
  id: string;
  operation: string;
  createdAt: number;
  data: Readonly<Record<string, unknown>>;
}

export interface AppSnapshot {
  revision: number;
  mode: AgentMode;
  displayMode: AgentMode | 'review';
  run: RunSnapshot;
  queue: QueueSnapshot;
  permissions: PermissionSnapshot;
  session?: SessionSnapshot;
  notice?: NoticeDescriptor;
  panel?: PanelDescriptor;
  interaction?: InteractionDescriptor;
  commandOutputs: readonly CommandOutput[];
  commandError?: CommandErrorSnapshot;
  agentError?: PublicError;
  audit: readonly AuditEvent[];
  chat: import('../../session/types.js').ChatSessionState;
}

export type AppEvent =
  | { type: 'notice.shown'; notice: NoticeDescriptor }
  | { type: 'notice.cleared'; id?: string }
  | { type: 'panel.opened'; panel: PanelDescriptor }
  | { type: 'panel.closed'; id?: string }
  | { type: 'interaction.opened'; interaction: InteractionDescriptor }
  | { type: 'interaction.closed'; id: string }
  | { type: 'command.output.appended'; output: CommandOutput }
  | { type: 'command.error'; error: CommandErrorSnapshot }
  | { type: 'command.error.cleared' }
  | { type: 'agent.error'; error: PublicError }
  | { type: 'agent.error.cleared' }
  | { type: 'mode.changed'; mode: AgentMode }
  | { type: 'review.started'; runId: string }
  | { type: 'review.finished' }
  | { type: 'run.changed'; run: RunSnapshot }
  | { type: 'queue.changed'; queue: QueueSnapshot }
  | { type: 'permission.changed'; permissions: PermissionSnapshot }
  | { type: 'session.activated'; session: SessionSnapshot; queue?: QueueSnapshot }
  | { type: 'session.updated'; session: SessionSnapshot; queue?: QueueSnapshot }
  | { type: 'session.renamed'; sessionId: string; name: string; updatedAt: number }
  | { type: 'audit.appended'; event: AuditEvent }
  | { type: 'chat.changed'; state: import('../../session/types.js').ChatSessionState };

export interface AppRuntimeOptions {
  mode: AgentMode;
  session?: SessionSnapshot;
  queue?: QueueSnapshot;
  permissions?: PermissionSnapshot;
  chat?: import('../../session/types.js').ChatSessionState;
}

export type AppRuntimeListener = (snapshot: AppSnapshot, event: AppEvent) => void;
