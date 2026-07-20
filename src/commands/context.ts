import { createId, type IdGenerator } from '../shared/ids.js';
import type { MemoryIndexSnapshot } from '../app/memory/MemoryManager.js';
import type { PermissionRuleView } from '../app/permissions/PermissionManager.js';
import type {
  AppSnapshot,
  PermissionSnapshot,
  SessionSnapshot,
} from '../app/runtime/types.js';
import type { SessionQueueSnapshot } from '../app/session/SessionQueueStore.js';
import type { WorkspaceSessionSummary } from '../app/session/SessionWorkspace.js';
import type { CommandOperation } from './types.js';

export interface CommandContext<TStatus = unknown> {
  executionId: string;
  app: AppSnapshot;
  session: SessionSnapshot;
  sessions: readonly WorkspaceSessionSummary[];
  queue: SessionQueueSnapshot;
  permissions: PermissionSnapshot;
  permissionRules: readonly PermissionRuleView[];
  memory: MemoryIndexSnapshot;
  status: TStatus;
}

export interface CommandContextBuilderOptions<TStatus = unknown> {
  getAppSnapshot: () => AppSnapshot;
  getSessionSnapshot: () => SessionSnapshot;
  getPermissionSnapshot: () => PermissionSnapshot;
  getPermissionRules?: () => Promise<readonly PermissionRuleView[]>;
  getMemorySnapshot: () => Promise<MemoryIndexSnapshot>;
  getSessionSnapshots?: () => Promise<readonly WorkspaceSessionSummary[]>;
  getQueueSnapshot?: () => SessionQueueSnapshot;
  getStatusSnapshot: (operation?: CommandOperation) => Promise<TStatus>;
  createExecutionId?: IdGenerator;
}

export class CommandContextBuilder<TStatus = unknown> {
  constructor(private readonly options: CommandContextBuilderOptions<TStatus>) {}

  async build(operation?: CommandOperation): Promise<CommandContext<TStatus>> {
    const [memory, status, sessions, permissionRules] = await Promise.all([
      this.options.getMemorySnapshot(),
      this.options.getStatusSnapshot(operation),
      this.options.getSessionSnapshots?.() ?? Promise.resolve([]),
      this.options.getPermissionRules?.() ?? Promise.resolve([]),
    ]);
    const session = this.options.getSessionSnapshot();
    const app = this.options.getAppSnapshot();
    const context: CommandContext<TStatus> = {
      executionId: (this.options.createExecutionId ?? createId)('command'),
      app,
      session,
      sessions,
      queue: this.options.getQueueSnapshot?.() ?? {
        sessionId: session.id,
        version: app.queue.version,
        paused: app.queue.paused,
        restored: session.resumed,
        items: [],
      },
      permissions: this.options.getPermissionSnapshot(),
      permissionRules,
      memory,
      status,
    };
    return deepFreeze(structuredClone(context));
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
