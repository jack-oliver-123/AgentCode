import type { CommandActionExecutor } from '../../commands/dispatcher.js';
import type { CommandContext } from '../../commands/context.js';
import type { CommandAction, CommandOperation } from '../../commands/types.js';
import type { SteerGuidance } from '../../agent/types.js';
import type { InteractionCoordinator, InteractionRequest, InteractionResponse } from '../interaction/InteractionCoordinator.js';
import {
  memoryDeleteFingerprint,
  type MemoryDeleteTarget,
  type MemoryEntryContents,
  type MemoryManager,
} from '../memory/MemoryManager.js';
import type { PermissionManager } from '../permissions/PermissionManager.js';
import type { FrozenReviewTarget, ReviewTargetInput } from '../review/targetFreeze.js';
import type { ReviewRunner } from '../review/ReviewRunner.js';
import type { SessionWorkspace } from '../session/SessionWorkspace.js';
import type { AppRuntime } from './AppRuntime.js';
import type { AppSessionRuntime, RuntimeSessionController } from './AppSessionRuntime.js';

export interface AppCommandExecutorOptions {
  runtime: AppRuntime;
  sessions: AppSessionRuntime;
  workspace: SessionWorkspace<RuntimeSessionController>;
  interactions: InteractionCoordinator;
  permissions: PermissionManager;
  memory: MemoryManager;
  freezeReviewTarget: (input: ReviewTargetInput, signal?: AbortSignal) => Promise<FrozenReviewTarget>;
  reviewRunner: ReviewRunner;
  refreshCompletionSources?: (source: 'sessions' | 'memory' | 'permissions') => Promise<void>;
  now?: () => number;
}

export class AppCommandExecutor implements CommandActionExecutor {
  private readonly prepared = new Map<string, unknown>();
  private activeReview: {
    id: string;
    abortController: AbortController;
    pendingSteers: SteerGuidance[];
    startMode: 'default' | 'plan';
  } | undefined;
  private reviewPreflight: {
    id: string;
    abortController: AbortController;
    startMode: 'default' | 'plan';
  } | undefined;
  private reviewSteerSequence = 0;

  constructor(private readonly options: AppCommandExecutorOptions) {}

  dispose(): void {
    this.activeReview?.abortController.abort();
    const preflight = this.reviewPreflight;
    preflight?.abortController.abort();
    if (preflight !== undefined) void this.finishReviewPreflight(preflight);
    this.prepared.clear();
  }

  interactionClosed(request: InteractionRequest): void {
    if (request.kind === 'confirm-memory-delete') this.prepared.delete(request.idempotencyKey);
  }

  async steerReview(text: string): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    const review = this.activeReview;
    if (review === undefined || !this.options.runtime.getSnapshot().run.reviewActive) {
      return { accepted: false, reason: 'no_active_run' };
    }
    const guidance = await this.options.sessions.recordExternalSteer(review.id, text);
    if (this.activeReview !== review) return { accepted: false, reason: 'run_ended' };
    if (guidance === undefined) return { accepted: false, reason: 'persistence_failed' };
    review.pendingSteers.push(guidance);
    this.reviewSteerSequence += 1;
    this.appendAudit(`${review.id}:steer:${this.reviewSteerSequence}`, 'review.steer', { runId: review.id });
    return { accepted: true };
  }

  async preflight(action: CommandAction, context: CommandContext, _operation: CommandOperation): Promise<void> {
    if (
      requiresCurrentSession(action) &&
      this.options.workspace.getActiveSnapshot().id !== context.session.id
    ) {
      throw new Error('Active session changed before command preflight.');
    }
    switch (action.type) {
      case 'activate_session':
        await this.options.workspace.resolveSession(action.sessionId);
        return;
      case 'show_memory':
        this.prepared.set(action.idempotencyKey, await this.options.memory.read(action.scope, action.entry));
        return;
      case 'request_memory_delete':
        this.prepared.set(action.idempotencyKey, await this.options.memory.prepareDelete(action.scope, action.entry));
        return;
      case 'request_permission_rule_remove': {
        const rule = (await this.options.permissions.getRuleViews(action.scope)).find(
          (candidate) => candidate.id === action.ruleId,
        );
        if (
          rule?.fingerprint !== action.expectedFingerprint ||
          this.options.permissions.snapshot().generation !== action.expectedGeneration
        ) {
          throw new Error(`Permission rule changed before preflight: ${action.ruleId}`);
        }
        return;
      }
      case 'start_review':
        await this.prepareReview(action.idempotencyKey, action.target);
        return;
      case 'request_queue_remove': {
        const queue = this.options.workspace.getActiveQueue().snapshot();
        if (queue.version !== action.expectedVersion || queue.items[action.index - 1] === undefined) {
          throw new Error(`Queue item changed before preflight: ${action.index}`);
        }
        return;
      }
      case 'request_queue_clear':
        if (this.options.workspace.getActiveQueue().snapshot().version !== action.expectedVersion) {
          throw new Error('Queue changed before preflight.');
        }
        return;
      case 'submit_prompt':
        if (context.app.run.phase !== 'idle') throw new Error('A run is already active.');
        return;
      case 'steer':
      case 'stop_run':
        if (context.app.run.phase === 'idle') throw new Error('No active run.');
        return;
      default:
        return;
    }
  }

  async commit(action: CommandAction, context: CommandContext, _operation: CommandOperation): Promise<unknown> {
    switch (action.type) {
      case 'show_notice':
        this.options.runtime.dispatch({
          type: 'notice.shown',
          notice: {
            id: action.idempotencyKey,
            level: action.level,
            text: action.text,
            ...(action.ttlMs !== undefined ? { ttlMs: action.ttlMs } : {}),
          },
        });
        return undefined;
      case 'append_command_output':
        this.options.runtime.dispatch({
          type: 'command.output.appended',
          output: {
            id: action.idempotencyKey,
            command: action.command,
            content: action.content,
            createdAt: (this.options.now ?? Date.now)(),
          },
        });
        return undefined;
      case 'open_panel':
        this.options.runtime.dispatch({ type: 'panel.opened', panel: action.panel });
        return undefined;
      case 'open_interaction':
        return this.openInteraction(this.options.interactions.request(action.request));
      case 'set_agent_mode':
        await this.options.sessions.setAgentMode(action.mode);
        await this.options.refreshCompletionSources?.('sessions');
        this.appendAudit(action.idempotencyKey, 'agent.mode', { mode: action.mode });
        return undefined;
      case 'submit_prompt': {
        const accepted = await this.options.sessions.submitPrompt(action.text);
        if (!accepted.accepted) throw new Error(accepted.reason);
        return undefined;
      }
      case 'compact':
        await this.options.sessions.compact(action.instructions);
        return undefined;
      case 'create_session':
        await this.options.workspace.createSession({
          ...(action.name !== undefined ? { name: action.name } : {}),
          selectedPermissionMode: this.options.permissions.snapshot().selectedMode,
        });
        await this.options.permissions.activateSession(this.options.workspace.getActiveSnapshot().id);
        await this.options.permissions.setModeCap({ agentMode: 'default', reviewActive: false });
        this.publishPermissions();
        this.options.sessions.publishCurrentState(true);
        this.expireInteractionsForInactiveSessions();
        await this.options.refreshCompletionSources?.('sessions');
        this.appendAudit(action.idempotencyKey, 'session.create', {
          sessionId: this.options.workspace.getActiveSnapshot().id,
        });
        return undefined;
      case 'activate_session': {
        const result = await this.activateSession(action.sessionId);
        await this.options.refreshCompletionSources?.('sessions');
        this.appendAudit(action.idempotencyKey, 'session.resume', { sessionId: result.session.id });
        return result;
      }
      case 'rename_session':
        await this.options.workspace.renameSession(action.name);
        {
          const session = this.options.workspace.getActiveSnapshot();
          this.options.runtime.dispatch({
            type: 'session.renamed',
            sessionId: action.sessionId,
            name: action.name,
            updatedAt: session.updatedAt,
          });
        }
        this.appendAudit(action.idempotencyKey, 'session.rename', {
          sessionId: action.sessionId,
          name: action.name,
        });
        await this.options.refreshCompletionSources?.('sessions');
        return undefined;
      case 'show_memory': {
        const contents = this.requirePrepared<MemoryEntryContents>(action.idempotencyKey);
        this.prepared.delete(action.idempotencyKey);
        this.options.runtime.dispatch({
          type: 'panel.opened',
          panel: {
            id: action.idempotencyKey,
            kind: 'memory',
            title: `${contents.scope.toUpperCase()} memory · ${contents.filename}`,
            data: contents,
          },
        });
        return contents;
      }
      case 'request_memory_delete': {
        const target = this.requirePrepared<MemoryDeleteTarget>(action.idempotencyKey);
        return this.openInteraction(this.options.interactions.request({
          kind: 'confirm-memory-delete',
          idempotencyKey: action.idempotencyKey,
          sessionId: context.session.id,
          operation: 'memory.delete',
          activeRunPolicy: 'immediate',
          allowedInReadonly: true,
          scope: target.scope,
          entry: target.filename,
          fingerprint: memoryDeleteFingerprint(target),
        }));
      }
      case 'delete_memory':
        await this.options.memory.delete(action.target);
        return undefined;
      case 'set_permission_mode': {
        if (action.confirmed !== true && this.options.permissions.requiresModeConfirmation(action.mode)) {
          return this.openInteraction(this.options.interactions.request({
            kind: 'confirm-permission-mode',
            idempotencyKey: action.idempotencyKey,
            sessionId: context.session.id,
            operation: 'permission.mode',
            activeRunPolicy: 'immediate',
            allowedInReadonly: true,
            mode: action.mode,
            generation: context.permissions.generation,
          }));
        }
        await this.options.workspace.setSelectedPermissionMode(action.mode);
        const result = await this.options.permissions.setSelectedMode(action.mode, {
          confirmed: true,
          ...(context.app.run.id !== undefined ? { activeRunId: context.app.run.id } : {}),
        });
        this.publishPermissions();
        this.options.sessions.publishCurrentState();
        await this.options.refreshCompletionSources?.('permissions');
        return result;
      }
      case 'remove_permission_rule':
        await this.options.permissions.removeRule(action.scope, action.ruleId, {
          expectedGeneration: action.expectedGeneration,
          ...(context.app.run.id !== undefined ? { activeRunId: context.app.run.id } : {}),
        });
        this.publishPermissions();
        return undefined;
      case 'request_permission_rule_remove':
        return this.openInteraction(this.options.interactions.request({
          kind: 'confirm-permission-remove',
          idempotencyKey: action.idempotencyKey,
          sessionId: context.session.id,
          operation: 'permission.remove',
          activeRunPolicy: 'immediate',
          allowedInReadonly: true,
          scope: action.scope,
          ruleId: action.ruleId,
          generation: action.expectedGeneration,
          fingerprint: action.expectedFingerprint,
        }));
      case 'start_review': {
        const target = this.requirePrepared<FrozenReviewTarget>(action.idempotencyKey);
        this.prepared.delete(action.idempotencyKey);
        await this.startReview(action.idempotencyKey, target);
        return undefined;
      }
      case 'queue_add': {
        const result = await this.options.sessions.queueAdd(action.text);
        if (!result.accepted) throw new Error(result.reason);
        this.appendAudit(action.idempotencyKey, 'queue.add', { textLength: action.text.length });
        return undefined;
      }
      case 'queue_run':
        await this.options.sessions.queueRun();
        this.appendAudit(action.idempotencyKey, 'queue.run', {});
        return undefined;
      case 'queue_remove':
        if (action.expectedVersion !== undefined && this.options.workspace.getActiveQueue().snapshot().version !== action.expectedVersion) {
          throw new Error('Queue changed before removal.');
        }
        {
          const removed = await this.options.workspace.getActiveQueue().remove(action.index);
          this.options.sessions.publishCurrentState();
          this.appendAudit(action.idempotencyKey, 'queue.remove', { index: action.index, itemId: removed?.id });
          return removed;
        }
      case 'queue_clear':
        if (action.expectedVersion !== undefined && this.options.workspace.getActiveQueue().snapshot().version !== action.expectedVersion) {
          throw new Error('Queue changed before clear.');
        }
        await this.options.workspace.getActiveQueue().clear();
        this.options.sessions.publishCurrentState();
        this.appendAudit(action.idempotencyKey, 'queue.clear', {});
        return undefined;
      case 'request_queue_remove':
        return this.openInteraction(this.options.interactions.request({
          kind: 'confirm-queue-remove',
          idempotencyKey: action.idempotencyKey,
          sessionId: context.session.id,
          operation: 'queue.remove',
          activeRunPolicy: 'immediate',
          allowedInReadonly: true,
          index: action.index,
          queueVersion: action.expectedVersion,
        }));
      case 'request_queue_clear':
        return this.openInteraction(this.options.interactions.request({
          kind: 'confirm-queue-clear',
          idempotencyKey: action.idempotencyKey,
          sessionId: context.session.id,
          operation: 'queue.clear',
          activeRunPolicy: 'immediate',
          allowedInReadonly: true,
          queueVersion: action.expectedVersion,
        }));
      case 'steer': {
        if (this.options.runtime.getSnapshot().run.reviewActive) {
          const result = await this.steerReview(action.text);
          if (!result.accepted) throw new Error(result.reason);
          return undefined;
        }
        const result = await this.options.sessions.steer(action.text);
        if (!result.accepted) throw new Error(result.reason);
        this.appendAudit(action.idempotencyKey, 'run.steer', { runId: context.app.run.id });
        return undefined;
      }
      case 'stop_run': {
        if (this.options.runtime.getSnapshot().run.reviewActive) {
          const review = this.activeReview;
          const preflight = this.reviewPreflight;
          if (review === undefined && preflight === undefined) throw new Error('No active review operation.');
          review?.abortController.abort();
          preflight?.abortController.abort();
          await this.options.sessions.pauseQueue();
          if (preflight !== undefined) await this.finishReviewPreflight(preflight);
          this.appendAudit(action.idempotencyKey, 'review.stop', { runId: review?.id ?? preflight?.id });
          return undefined;
        }
        const result = await this.options.sessions.stopRun();
        if (!result.accepted) throw new Error(result.reason);
        this.options.runtime.dispatch({
          type: 'notice.shown',
          notice: {
            id: `${action.idempotencyKey}:notice`,
            level: 'warn',
            text: 'Run stopped. Completed tool side effects were not rolled back.',
            ttlMs: 8_000,
          },
        });
        this.appendAudit(action.idempotencyKey, 'run.stop', { runId: context.app.run.id });
        return undefined;
      }
    }
  }

  async executeInteraction(request: InteractionRequest, response: InteractionResponse): Promise<unknown> {
    switch (request.kind) {
      case 'confirm-memory-delete': {
        const target = this.requirePrepared<MemoryDeleteTarget>(request.idempotencyKey);
        await this.options.memory.delete(target);
        this.prepared.delete(request.idempotencyKey);
        this.appendAudit(request.idempotencyKey, 'memory.delete', {
          scope: target.scope,
          entry: target.filename,
        });
        await this.options.refreshCompletionSources?.('memory');
        return target.filename;
      }
      case 'confirm-permission-remove':
        await this.options.permissions.removeRule(request.scope, request.ruleId, {
          expectedGeneration: request.generation,
          expectedFingerprint: request.fingerprint,
          ...(this.options.runtime.getSnapshot().run.id !== undefined
            ? { activeRunId: this.options.runtime.getSnapshot().run.id }
            : {}),
        });
        this.publishPermissions();
        await this.options.refreshCompletionSources?.('permissions');
        return request.ruleId;
      case 'confirm-permission-mode':
        if (this.options.permissions.snapshot().generation !== request.generation) {
          throw new Error('Permission generation changed before confirmation.');
        }
        await this.options.workspace.setSelectedPermissionMode(request.mode);
        await this.options.permissions.setSelectedMode(request.mode, {
          confirmed: true,
          ...(this.options.runtime.getSnapshot().run.id !== undefined
            ? { activeRunId: this.options.runtime.getSnapshot().run.id }
            : {}),
        });
        this.publishPermissions();
        this.options.sessions.publishCurrentState();
        await this.options.refreshCompletionSources?.('permissions');
        return request.mode;
      case 'confirm-queue-remove': {
        if (this.options.workspace.getActiveQueue().snapshot().version !== request.queueVersion) {
          throw new Error('Queue changed before confirmation.');
        }
        const removed = await this.options.workspace.getActiveQueue().remove(request.index);
        this.options.sessions.publishCurrentState();
        this.appendAudit(request.idempotencyKey, 'queue.remove', {
          index: request.index,
          itemId: removed?.id,
        });
        return removed;
      }
      case 'confirm-queue-clear':
        if (this.options.workspace.getActiveQueue().snapshot().version !== request.queueVersion) {
          throw new Error('Queue changed before confirmation.');
        }
        await this.options.workspace.getActiveQueue().clear();
        this.options.sessions.publishCurrentState();
        this.appendAudit(request.idempotencyKey, 'queue.clear', {});
        return undefined;
      case 'session-picker':
        if (response.kind !== 'selected') throw new Error('Session picker requires a selected response.');
        await this.activateSession(response.value);
        await this.options.refreshCompletionSources?.('sessions');
        this.appendAudit(request.idempotencyKey, 'session.resume', { sessionId: response.value });
        return response.value;
      case 'tool-approval':
        return response;
    }
  }

  private openInteraction(request: InteractionRequest): InteractionRequest {
    this.options.runtime.dispatch({
      type: 'interaction.opened',
      interaction: { id: request.id, kind: request.kind, data: request },
    });
    return request;
  }

  private async startReview(reviewId: string, target: FrozenReviewTarget): Promise<void> {
    if (this.activeReview !== undefined) throw new Error('A review operation is already active.');
    const prepared = this.reviewPreflight;
    if (prepared === undefined || prepared.id !== reviewId) {
      throw new Error('Review preflight is no longer active.');
    }
    this.reviewPreflight = undefined;
    const review = {
      id: reviewId,
      abortController: prepared.abortController,
      pendingSteers: [] as SteerGuidance[],
      startMode: prepared.startMode,
    };
    this.activeReview = review;
    this.appendAudit(reviewId, 'review.start', {
      kind: target.kind,
      diffHash: target.diffHash,
    });
    void this.finishReview(review, target).catch((error) => {
      this.options.runtime.dispatch({
        type: 'command.error',
        error: { code: 'review_cleanup_failed', message: errorMessage(error), at: (this.options.now ?? Date.now)() },
      });
    });
  }

  private async finishReview(
    review: NonNullable<AppCommandExecutor['activeReview']>,
    target: FrozenReviewTarget,
  ): Promise<void> {
    try {
      const result = await this.options.reviewRunner.run(
        target,
        review.abortController.signal,
        () => review.pendingSteers.splice(0),
      );
      this.options.sessions.publishCurrentState();
      this.options.runtime.dispatch({
        type: 'panel.opened',
        panel: { id: review.id, kind: 'review', title: 'Review', data: result },
      });
      this.appendAudit(review.id, 'review.complete', { findings: result.findings.length });
    } catch (error) {
      if (review.abortController.signal.aborted) {
        this.options.runtime.dispatch({
          type: 'notice.shown',
          notice: { id: `${review.id}:stopped`, level: 'warn', text: 'Review stopped.', ttlMs: 5_000 },
        });
      } else {
        await this.options.sessions.pauseQueue();
        this.options.runtime.dispatch({
          type: 'command.error',
          error: {
            code: errorCode(error),
            message: errorMessage(error),
            at: (this.options.now ?? Date.now)(),
          },
        });
      }
    } finally {
      try {
        await this.options.permissions.setModeCap({
          agentMode: review.startMode,
          reviewActive: false,
        });
        this.publishPermissions();
      } finally {
        if (this.activeReview === review) this.activeReview = undefined;
        this.options.runtime.dispatch({ type: 'review.finished' });
        this.options.sessions.drainQueueIfReady();
      }
    }
  }

  private async activateSession(target: string) {
    const result = await this.options.workspace.resumeSession(target);
    if (result.kind === 'activated') {
      await this.options.permissions.activateSession(result.session.id);
      await this.options.permissions.setSelectedMode(result.session.selectedPermissionMode, { confirmed: true });
      await this.options.permissions.setModeCap({ agentMode: result.session.agentMode, reviewActive: false });
      this.publishPermissions();
      this.options.sessions.publishCurrentState(true);
      this.expireInteractionsForInactiveSessions();
    }
    return result;
  }

  private async prepareReview(reviewId: string, target: ReviewTargetInput): Promise<void> {
    if (this.activeReview !== undefined || this.reviewPreflight !== undefined) {
      throw new Error('A review operation is already active.');
    }
    const preflight = {
      id: reviewId,
      abortController: new AbortController(),
      startMode: this.options.runtime.getSnapshot().mode,
    };
    this.reviewPreflight = preflight;
    this.options.runtime.dispatch({ type: 'review.started', runId: reviewId });
    try {
      await this.options.permissions.setModeCap({ agentMode: preflight.startMode, reviewActive: true });
      this.publishPermissions();
      preflight.abortController.signal.throwIfAborted();
      const frozen = await this.options.freezeReviewTarget(target, preflight.abortController.signal);
      if (preflight.abortController.signal.aborted || this.reviewPreflight !== preflight) {
        throw new Error('Review preflight was cancelled.');
      }
      this.prepared.set(reviewId, frozen);
    } catch (error) {
      try {
        await this.finishReviewPreflight(preflight);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Review preflight and cleanup both failed.');
      }
      throw error;
    }
  }

  private async finishReviewPreflight(
    preflight: NonNullable<AppCommandExecutor['reviewPreflight']>,
  ): Promise<void> {
    if (this.reviewPreflight !== preflight) return;
    this.reviewPreflight = undefined;
    this.prepared.delete(preflight.id);
    try {
      await this.options.permissions.setModeCap({ agentMode: preflight.startMode, reviewActive: false });
      this.publishPermissions();
    } finally {
      this.options.runtime.dispatch({ type: 'review.finished' });
    }
  }

  private appendAudit(id: string, operation: string, data: Readonly<Record<string, unknown>>): void {
    this.options.runtime.dispatch({
      type: 'audit.appended',
      event: {
        id: `command-${id}-${operation}`,
        operation,
        createdAt: (this.options.now ?? Date.now)(),
        data,
      },
    });
  }

  private expireInteractionsForInactiveSessions(): void {
    const sessionId = this.options.workspace.getActiveSnapshot().id;
    this.options.interactions.expire(
      (request) => request.sessionId !== sessionId,
      'session_changed',
    );
  }

  private publishPermissions(): void {
    this.options.runtime.dispatch({ type: 'permission.changed', permissions: this.options.permissions.snapshot() });
  }

  private requirePrepared<T>(key: string): T {
    if (!this.prepared.has(key)) throw new Error(`Missing preflight result for ${key}.`);
    return this.prepared.get(key) as T;
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'review_failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiresCurrentSession(action: CommandAction): boolean {
  return action.type !== 'show_notice' &&
    action.type !== 'append_command_output' &&
    action.type !== 'open_panel' &&
    action.type !== 'show_memory';
}
