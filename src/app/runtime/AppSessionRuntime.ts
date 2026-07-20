import type { AgentMode, AppSnapshot } from './types.js';
import type { InputWorkspacePort, RouteAcceptance } from './InputRouter.js';
import type { ChatSessionEvent, ChatSessionState } from '../../session/types.js';
import type {
  RecordedSteerAcceptance,
  SessionControlAcceptance,
  SubmitUserTextOptions,
} from '../../session/ChatSessionController.js';
import type { SteerGuidance } from '../../agent/types.js';
import type { SessionQueueItem, SessionQueueSnapshot } from '../session/SessionQueueStore.js';
import type { SessionWorkspace, SessionWorkspaceController } from '../session/SessionWorkspace.js';
import type { AppRuntime } from './AppRuntime.js';

export interface RuntimeSessionController extends SessionWorkspaceController {
  getState(): ChatSessionState;
  getActiveRun(): { id: string; phase: 'streaming' } | undefined;
  submitUserText(text: string, options?: SubmitUserTextOptions): AsyncIterable<ChatSessionEvent>;
  compactContext(instructions?: string): AsyncIterable<ChatSessionEvent>;
  steer(text: string): Promise<SessionControlAcceptance>;
  recordExternalSteer(runId: string, text: string): Promise<RecordedSteerAcceptance>;
  stopRun(): Promise<SessionControlAcceptance>;
  setAgentMode(mode: AgentMode): ChatSessionEvent;
  getContextStatus(): { estimatedTokens: number; contextWindow: number; compaction: string };
  persistReviewResult(reviewId: string, content: unknown): Promise<void>;
}

interface LaunchedTurn {
  completion: Promise<ChatSessionState>;
}

export interface AppSessionRuntimeOptions {
  onAgentModeChanged?: (mode: AgentMode) => void | Promise<void>;
}

export class AppSessionRuntime implements InputWorkspacePort {
  private activeCompletion: Promise<ChatSessionState> | undefined;
  private activeSettlement: Promise<void> | undefined;
  private starting = false;
  private drainPromise: Promise<void> | undefined;
  private queueDraining = false;
  private stopRequested = false;

  constructor(
    private readonly runtime: AppRuntime,
    private readonly workspace: SessionWorkspace<RuntimeSessionController>,
    private readonly options: AppSessionRuntimeOptions = {},
  ) {
    this.publishCurrentState(true);
  }

  getAppSnapshot(): AppSnapshot {
    return this.runtime.getSnapshot();
  }

  async submitPrompt(text: string): Promise<RouteAcceptance> {
    if (this.isActive() || this.queueDraining) return { accepted: false, reason: 'run_active' };
    const launched = await this.launchTurn(text);
    if (launched === undefined) return { accepted: false, reason: 'run_start_failed' };
    const settlement = launched.completion
      .then((state) => this.afterDirectTurn(state))
      .catch((error) => this.reportTurnFailure(error));
    this.activeSettlement = settlement;
    const clearSettlement = (): void => {
      if (this.activeSettlement === settlement) this.activeSettlement = undefined;
    };
    void settlement.then(clearSettlement, clearSettlement);
    return { accepted: true };
  }

  async steer(text: string): Promise<RouteAcceptance> {
    const result = await this.workspace.getActiveController().steer(text);
    if (!result.accepted) return { accepted: false, reason: result.reason };
    this.publishChat(this.workspace.getActiveController().getState());
    return { accepted: true };
  }

  async recordExternalSteer(runId: string, text: string): Promise<SteerGuidance | undefined> {
    const result = await this.workspace.getActiveController().recordExternalSteer(runId, text);
    if (!result.accepted) return undefined;
    this.publishChat(this.workspace.getActiveController().getState());
    return result.guidance;
  }

  async queueAdd(text: string): Promise<RouteAcceptance> {
    try {
      await this.workspace.getActiveQueue().add(text, this.workspace.getActiveSnapshot().agentMode);
      this.publishQueue();
      if (!this.isActive() && !this.workspace.getActiveQueue().snapshot().paused) this.scheduleQueueDrain();
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: errorMessage(error) };
    }
  }

  async queueRun(): Promise<void> {
    await this.workspace.getActiveQueue().resume();
    this.publishQueue();
    this.scheduleQueueDrain();
  }

  async stopRun(): Promise<RouteAcceptance> {
    const completion = this.activeCompletion;
    const settlement = this.activeSettlement;
    const drain = this.drainPromise;
    this.stopRequested = true;
    try {
      const result = await this.workspace.getActiveController().stopRun();
      if (!result.accepted) return { accepted: false, reason: result.reason };
      await completion?.catch(() => undefined);
      await settlement?.catch(() => undefined);
      await drain?.catch(() => undefined);
      await this.pauseQueue();
      return { accepted: true };
    } finally {
      this.stopRequested = false;
    }
  }

  async pauseQueue(): Promise<void> {
    if (this.workspace.getActiveQueue().snapshot().items.length === 0) return;
    await this.workspace.getActiveQueue().pause();
    this.publishQueue();
  }

  drainQueueIfReady(): void {
    const queue = this.workspace.getActiveQueue().snapshot();
    if (!this.stopRequested && !this.isActive() && queue.items.length > 0 && !queue.paused) this.scheduleQueueDrain();
  }

  async compact(instructions?: string): Promise<void> {
    for await (const event of this.workspace.getActiveController().compactContext(instructions)) {
      this.publishChat(event.state);
    }
  }

  async setAgentMode(mode: AgentMode): Promise<void> {
    await this.workspace.setAgentMode(mode);
    this.workspace.getActiveController().setAgentMode(mode);
    this.runtime.dispatch({ type: 'mode.changed', mode });
    await this.options.onAgentModeChanged?.(mode);
    this.publishCurrentState();
  }

  publishCurrentState(activated = false): void {
    this.runtime.dispatch({
      type: activated ? 'session.activated' : 'session.updated',
      session: this.workspace.getActiveSnapshot(),
      queue: toRuntimeQueue(this.workspace.getActiveQueue().snapshot(), this.queueDraining),
    });
    this.publishChat(this.workspace.getActiveController().getState());
  }

  async dispose(): Promise<void> {
    if (this.workspace.getActiveQueue().snapshot().items.length > 0) {
      await this.workspace.getActiveQueue().pause().catch(() => undefined);
    }
    if (this.workspace.getActiveController().getActiveRun() !== undefined) {
      await this.workspace.getActiveController().stopRun().catch(() => undefined);
    }
    await this.activeCompletion?.catch(() => undefined);
    await this.activeSettlement?.catch(() => undefined);
    await this.drainPromise?.catch(() => undefined);
    await this.workspace.close();
  }

  private async launchTurn(text: string): Promise<LaunchedTurn | undefined> {
    if (this.isActive()) return undefined;
    this.starting = true;
    try {
      const controller = this.workspace.getActiveController();
      const iterator = controller.submitUserText(text)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) return undefined;
      this.publishChat(first.value.state);
      const completion = this.consumeTurn(iterator, first.value.state);
      this.activeCompletion = completion;
      const clearActive = (): void => {
        if (this.activeCompletion === completion) this.activeCompletion = undefined;
      };
      void completion.then(clearActive, clearActive);
      return { completion };
    } finally {
      this.starting = false;
    }
  }

  private async consumeTurn(
    iterator: AsyncIterator<ChatSessionEvent>,
    initial: ChatSessionState,
  ): Promise<ChatSessionState> {
    let state = initial;
    while (true) {
      const next = await iterator.next();
      if (next.done) return state;
      state = next.value.state;
      this.publishChat(state);
    }
  }

  private async afterDirectTurn(state: ChatSessionState): Promise<void> {
    await this.recordTurn();
    const queue = this.workspace.getActiveQueue();
    if (this.stopRequested && queue.snapshot().items.length > 0) {
      await queue.pause();
      this.publishQueue();
      return;
    }
    if ((state.status === 'error' || state.status === 'stopped') && queue.snapshot().items.length > 0) {
      await queue.pause();
      this.publishQueue();
      return;
    }
    if (state.status === 'idle' && queue.snapshot().items.length > 0 && !queue.snapshot().paused) {
      this.scheduleQueueDrain();
    }
  }

  private ensureQueueDrain(): Promise<void> {
    if (this.drainPromise !== undefined) return this.drainPromise;
    const operation = this.drainQueue();
    this.drainPromise = operation.finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private scheduleQueueDrain(): void {
    if (this.stopRequested) return;
    void this.ensureQueueDrain().catch((error) => this.reportQueueFailure(error));
  }

  private async drainQueue(): Promise<void> {
    this.queueDraining = true;
    this.publishQueue();
    const queue = this.workspace.getActiveQueue();
    try {
      while (!this.stopRequested && !queue.snapshot().paused) {
        if (this.isActive()) {
          await this.activeCompletion;
          continue;
        }
        if (this.stopRequested) return;
        const item = await queue.startNext();
        this.publishQueue();
        if (item === undefined) return;
        const completed = await this.runQueuedItem(item);
        if (!completed) return;
      }
    } finally {
      this.queueDraining = false;
      this.publishQueue();
    }
  }

  private async runQueuedItem(item: SessionQueueItem): Promise<boolean> {
    let launched: LaunchedTurn | undefined;
    try {
      await this.setAgentMode(item.agentMode);
      launched = await this.launchTurn(item.text);
    } catch (error) {
      await this.workspace.getActiveQueue().fail(item.id);
      this.publishQueue();
      this.reportQueueFailure(error);
      return false;
    }
    if (launched === undefined) {
      await this.workspace.getActiveQueue().fail(item.id);
      this.publishQueue();
      this.reportQueueFailure(new Error('Queue turn did not start.'));
      return false;
    }
    let state: ChatSessionState;
    try {
      state = await launched.completion;
    } catch (error) {
      await this.workspace.getActiveQueue().fail(item.id);
      this.publishQueue();
      this.reportQueueFailure(error);
      return false;
    }
    await this.recordTurn();
    if (state.status !== 'idle') {
      await this.workspace.getActiveQueue().fail(item.id);
      this.publishQueue();
      this.reportQueueFailure(new Error(`Queue turn ended with status ${state.status}.`));
      return false;
    }
    await this.workspace.getActiveQueue().complete(item.id);
    this.publishQueue();
    return true;
  }

  private publishChat(state: ChatSessionState): void {
    const activeRun = this.workspace.getActiveController().getActiveRun();
    if (activeRun !== undefined) {
      this.runtime.dispatch({
        type: 'run.changed',
        run: { id: activeRun.id, phase: activeRun.phase, reviewActive: false },
      });
    }
    this.runtime.dispatch({ type: 'chat.changed', state });
  }

  private publishQueue(): void {
    this.runtime.dispatch({
      type: 'queue.changed',
      queue: toRuntimeQueue(this.workspace.getActiveQueue().snapshot(), this.queueDraining),
    });
  }

  private async recordTurn(): Promise<void> {
    try {
      await this.workspace.recordTurn();
      this.runtime.dispatch({
        type: 'session.updated',
        session: this.workspace.getActiveSnapshot(),
        queue: toRuntimeQueue(this.workspace.getActiveQueue().snapshot(), this.queueDraining),
      });
    } catch (error) {
      this.runtime.dispatch({
        type: 'command.error',
        error: { code: 'session_persist_failed', message: errorMessage(error), at: Date.now() },
      });
    }
  }

  private async reportTurnFailure(error: unknown): Promise<void> {
    const queue = this.workspace.getActiveQueue();
    if (queue.snapshot().items.length > 0) {
      await queue.pause().catch(() => undefined);
      this.publishQueue();
    }
    this.runtime.dispatch({
      type: 'agent.error',
      error: { code: 'unknown_error', message: errorMessage(error), retryable: false },
    });
  }

  private reportQueueFailure(error: unknown): void {
    this.runtime.dispatch({
      type: 'command.output.appended',
      output: {
        id: `queue-failed-${Date.now()}`,
        command: 'queue',
        content: `Queue drain paused: ${errorMessage(error)}`,
        createdAt: Date.now(),
      },
    });
  }

  private isActive(): boolean {
    return this.starting ||
      this.activeCompletion !== undefined ||
      this.runtime.getSnapshot().run.reviewActive ||
      this.workspace.getActiveController().getActiveRun() !== undefined;
  }
}

function toRuntimeQueue(
  queue: SessionQueueSnapshot,
  draining: boolean,
): import('./types.js').QueueSnapshot {
  return {
    count: queue.items.length,
    paused: queue.paused,
    draining,
    version: queue.version,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
