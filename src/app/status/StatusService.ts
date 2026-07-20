import type { ProviderProtocol } from '../../config/schema.js';
import type { PublicError } from '../../shared/errors.js';
import type { MemoryStatusSnapshot } from '../memory/MemoryManager.js';
import type {
  AgentMode,
  AppSnapshot,
  CommandErrorSnapshot,
  EffectivePermissionMode,
  PermissionMode,
  RunPhase,
} from '../runtime/types.js';

export interface ContextStatus {
  estimatedTokens: number;
  contextWindow: number;
  compaction: string;
}

export interface GitProbeResult {
  branch: string;
  dirty: boolean;
}

export interface McpProbeResult {
  configured: number;
  connected: number;
  failed: number;
}

export interface StatusServiceOptions {
  getAppSnapshot: () => AppSnapshot;
  cwd: string;
  provider: {
    protocol: ProviderProtocol;
    model: string;
    thinkingEnabled: boolean;
  };
  getContextStatus: () => ContextStatus;
  getMemoryStatus: (signal?: AbortSignal) => Promise<MemoryStatusSnapshot>;
  probeGit: (signal?: AbortSignal) => Promise<GitProbeResult>;
  probeMcp: (signal?: AbortSignal) => Promise<McpProbeResult>;
  config: { source: 'project' | 'global'; path: string };
  probeTimeoutMs?: number;
  now?: () => number;
}

export interface StatusBarSnapshot {
  mode: AgentMode | 'review';
  runStatus: RunPhase;
  model: string;
  estimatedTokens: number;
  queueCount: number;
  queuePaused: boolean;
  contextPercent: number;
}

export type ProbeSection<T> = ({ status: 'available' } & T) | { status: 'unknown' } | { status: 'unavailable' };

export interface DetailedStatusSnapshot {
  generatedAt: number;
  runtime: {
    mode: AgentMode | 'review';
    runStatus: RunPhase;
    cwd: string;
    queueCount: number;
    queuePaused: boolean;
  };
  provider: {
    protocol: ProviderProtocol;
    model: string;
    thinkingEnabled: boolean;
  };
  context: ContextStatus & { percent: number; estimated: true };
  session?: AppSnapshot['session'];
  permission: {
    selectedMode: PermissionMode;
    effectiveMode: EffectivePermissionMode;
    generation: number;
    counts: { session: number; project: number; global: number };
  };
  memory: MemoryStatusSnapshot | { status: 'unavailable' };
  git: ProbeSection<GitProbeResult>;
  mcp: ProbeSection<McpProbeResult>;
  config: { source: 'project' | 'global'; path: string };
  errors: {
    command?: CommandErrorSnapshot;
    agent?: PublicError;
  };
}

export class StatusService {
  constructor(private readonly options: StatusServiceOptions) {}

  getStatusBar(): StatusBarSnapshot {
    const app = this.options.getAppSnapshot();
    const context = this.options.getContextStatus();
    return {
      mode: app.displayMode,
      runStatus: app.run.phase,
      model: this.options.provider.model,
      estimatedTokens: context.estimatedTokens,
      queueCount: app.queue.count,
      queuePaused: app.queue.paused,
      contextPercent: contextPercent(context),
    };
  }

  async getDetailedStatus(): Promise<DetailedStatusSnapshot> {
    const app = this.options.getAppSnapshot();
    const context = this.options.getContextStatus();
    const timeoutMs = this.options.probeTimeoutMs ?? 1_500;
    const [git, mcp, memory] = await Promise.all([
      boundedProbe(this.options.probeGit, timeoutMs),
      boundedProbe(this.options.probeMcp, timeoutMs),
      boundedValue(this.options.getMemoryStatus, timeoutMs),
    ]);

    return {
      generatedAt: (this.options.now ?? Date.now)(),
      runtime: {
        mode: app.displayMode,
        runStatus: app.run.phase,
        cwd: this.options.cwd,
        queueCount: app.queue.count,
        queuePaused: app.queue.paused,
      },
      provider: { ...this.options.provider },
      context: {
        ...context,
        percent: contextPercent(context),
        estimated: true,
      },
      ...(app.session !== undefined ? { session: app.session } : {}),
      permission: {
        selectedMode: app.permissions.selectedMode,
        effectiveMode: app.permissions.effectiveMode,
        generation: app.permissions.generation,
        counts: app.permissions.counts,
      },
      memory: memory.status === 'available' ? memory.value : { status: 'unavailable' },
      git,
      mcp,
      config: { ...this.options.config },
      errors: {
        ...(app.commandError !== undefined ? { command: app.commandError } : {}),
        ...(app.agentError !== undefined ? { agent: app.agentError } : {}),
      },
    };
  }
}

function contextPercent(context: ContextStatus): number {
  if (context.contextWindow <= 0) return 0;
  return Math.max(0, Math.round((context.estimatedTokens / context.contextWindow) * 100));
}

async function boundedProbe<T>(
  probe: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<ProbeSection<T>> {
  const result = await runBounded(probe, timeoutMs);
  if (result.kind === 'value') return { status: 'available', ...result.value };
  return { status: result.kind === 'timeout' ? 'unknown' : 'unavailable' };
}

async function boundedValue<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ status: 'available'; value: T } | { status: 'unavailable' }> {
  const result = await runBounded(operation, timeoutMs);
  return result.kind === 'value' ? { status: 'available', value: result.value } : { status: 'unavailable' };
}

async function runBounded<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'error' }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveTimeout({ kind: 'timeout' });
    }, timeoutMs);
  });
  const value = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (result) => ({ kind: 'value' as const, value: result }),
      () => ({ kind: 'error' as const }),
    );
  try {
    return await Promise.race([value, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
