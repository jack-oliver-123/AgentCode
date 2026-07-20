import type {
  AppEvent,
  AppRuntimeListener,
  AppRuntimeOptions,
  AppSnapshot,
  PermissionSnapshot,
  QueueSnapshot,
} from './types.js';

const EMPTY_QUEUE: QueueSnapshot = {
  count: 0,
  paused: false,
  draining: false,
  version: 0,
};

const DEFAULT_PERMISSIONS: PermissionSnapshot = {
  selectedMode: 'normal',
  effectiveMode: 'normal',
  generation: 0,
  counts: { session: 0, project: 0, global: 0 },
};

export class AppRuntime {
  private snapshot: AppSnapshot;
  private readonly listeners = new Set<AppRuntimeListener>();
  private readonly eventQueue: AppEvent[] = [];
  private dispatching = false;

  constructor(options: AppRuntimeOptions) {
    const selectedMode = options.permissions?.selectedMode ?? options.session?.selectedPermissionMode ?? 'normal';
    const mode = options.session?.agentMode ?? options.mode;
    const chat = options.chat ?? {
      messages: [],
      status: 'idle',
      mode,
    };
    this.snapshot = freezeSnapshot({
      revision: 0,
      mode,
      displayMode: mode,
      run: { phase: 'idle', reviewActive: false },
      queue: options.queue ?? EMPTY_QUEUE,
      permissions: options.permissions ?? { ...DEFAULT_PERMISSIONS, selectedMode, effectiveMode: mode === 'plan' ? 'readonly' : selectedMode },
      ...(options.session !== undefined ? { session: options.session } : {}),
      commandOutputs: [],
      audit: [],
      chat,
      ...(chat.lastError !== undefined ? { agentError: chat.lastError } : {}),
    });
  }

  getSnapshot = (): AppSnapshot => this.snapshot;

  subscribe(listener: AppRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: AppEvent): void {
    this.eventQueue.push(event);
    if (this.dispatching) return;

    this.dispatching = true;
    try {
      while (this.eventQueue.length > 0) {
        const next = this.eventQueue.shift()!;
        this.snapshot = freezeSnapshot(reduceAppEvent(this.snapshot, next));
        for (const listener of [...this.listeners]) listener(this.snapshot, next);
      }
    } finally {
      this.dispatching = false;
    }
  }
}

export function reduceAppEvent(snapshot: AppSnapshot, event: AppEvent): AppSnapshot {
  const base = { ...snapshot, revision: snapshot.revision + 1 };
  switch (event.type) {
    case 'notice.shown':
      return { ...base, notice: event.notice };
    case 'notice.cleared':
      if (event.id !== undefined && snapshot.notice?.id !== event.id) return base;
      return omit(base, 'notice');
    case 'panel.opened':
      return { ...base, panel: event.panel };
    case 'panel.closed':
      if (event.id !== undefined && snapshot.panel?.id !== event.id) return base;
      return omit(base, 'panel');
    case 'interaction.opened':
      return { ...base, interaction: event.interaction };
    case 'interaction.closed':
      return snapshot.interaction?.id === event.id ? omit(base, 'interaction') : base;
    case 'command.output.appended':
      return { ...base, commandOutputs: [...snapshot.commandOutputs, event.output] };
    case 'command.error':
      return { ...base, commandError: event.error };
    case 'command.error.cleared':
      return omit(base, 'commandError');
    case 'agent.error':
      return { ...base, agentError: event.error };
    case 'agent.error.cleared':
      return omit(base, 'agentError');
    case 'mode.changed':
      return applyMode(base, event.mode);
    case 'review.started':
      return {
        ...base,
        displayMode: 'review',
        run: { id: event.runId, phase: 'streaming', reviewActive: true },
        permissions: { ...base.permissions, effectiveMode: 'readonly' },
      };
    case 'review.finished':
      return applyMode({ ...base, run: { phase: 'idle', reviewActive: false } }, base.mode);
    case 'run.changed':
      return {
        ...base,
        run: event.run,
        displayMode: event.run.reviewActive ? 'review' : base.mode,
        permissions: {
          ...base.permissions,
          effectiveMode: event.run.reviewActive || base.mode === 'plan' ? 'readonly' : base.permissions.selectedMode,
        },
      };
    case 'queue.changed':
      return { ...base, queue: event.queue };
    case 'permission.changed':
      return {
        ...base,
        permissions: {
          ...event.permissions,
          effectiveMode: base.mode === 'plan' || base.run.reviewActive ? 'readonly' : event.permissions.selectedMode,
        },
      };
    case 'session.activated': {
      const nextMode = event.session.agentMode;
      const selectedMode = event.session.selectedPermissionMode;
      const {
        notice: _notice,
        panel: _panel,
        interaction: _interaction,
        commandError: _commandError,
        agentError: _agentError,
        ...cleanBase
      } = base;
      return applyMode(
        {
          ...cleanBase,
          session: event.session,
          queue: event.queue ?? EMPTY_QUEUE,
          run: { phase: 'idle', reviewActive: false },
          permissions: { ...base.permissions, selectedMode },
          commandOutputs: [],
        },
        nextMode,
      );
    }
    case 'session.renamed':
      if (snapshot.session?.id !== event.sessionId) return base;
      return {
        ...base,
        session: { ...snapshot.session, name: event.name, updatedAt: event.updatedAt },
      };
    case 'session.updated':
      return {
        ...base,
        session: event.session,
        ...(event.queue !== undefined ? { queue: event.queue } : {}),
      };
    case 'audit.appended':
      return { ...base, audit: [...snapshot.audit, event.event] };
    case 'chat.changed': {
      const next: AppSnapshot = {
        ...base,
        chat: event.state,
        mode: event.state.mode,
        displayMode: base.run.reviewActive ? 'review' : event.state.mode,
        run: {
          ...base.run,
          phase: base.run.reviewActive ? base.run.phase : phaseFromChat(event.state),
        },
      };
      return event.state.lastError !== undefined
        ? { ...next, agentError: event.state.lastError }
        : omit(next, 'agentError');
    }
  }
}

function phaseFromChat(state: AppSnapshot['chat']): AppSnapshot['run']['phase'] {
  if (state.status !== 'streaming') return 'idle';
  if (state.draft?.activity.type === 'tool') return 'tool_running';
  if (state.draft?.activity.type === 'retry') return 'retry_backoff';
  return 'streaming';
}

function applyMode(snapshot: AppSnapshot, mode: AppSnapshot['mode']): AppSnapshot {
  return {
    ...snapshot,
    mode,
    displayMode: snapshot.run.reviewActive ? 'review' : mode,
    permissions: {
      ...snapshot.permissions,
      effectiveMode: mode === 'plan' || snapshot.run.reviewActive ? 'readonly' : snapshot.permissions.selectedMode,
    },
  };
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const result = { ...value };
  delete result[key];
  return result;
}

function freezeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
