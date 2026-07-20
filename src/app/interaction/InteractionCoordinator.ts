import { createId, type IdGenerator } from '../../shared/ids.js';
import type { ActiveRunPolicy } from '../../commands/types.js';
import type { AgentMode } from '../runtime/types.js';

export interface InteractionRuntimeState {
  sessionId: string;
  activeRunExists: boolean;
  agentMode: AgentMode;
  reviewActive: boolean;
}

interface InteractionRequestBase {
  id: string;
  idempotencyKey: string;
  createdAt: number;
  sessionId: string;
  operation: string;
  activeRunPolicy: ActiveRunPolicy;
  allowedInReadonly: boolean;
}

export type InteractionRequest =
  | (InteractionRequestBase & {
      kind: 'session-picker';
      choices: readonly import('../session/SessionWorkspace.js').WorkspaceSessionSummary[];
    })
  | (InteractionRequestBase & {
      kind: 'confirm-memory-delete';
      scope: 'user' | 'project';
      entry: string;
      fingerprint: string;
    })
  | (InteractionRequestBase & {
      kind: 'confirm-permission-remove';
      scope: 'session' | 'project' | 'global';
      ruleId: string;
      generation: number;
      fingerprint: string;
    })
  | (InteractionRequestBase & {
      kind: 'confirm-queue-remove';
      index: number;
      queueVersion: number;
    })
  | (InteractionRequestBase & {
      kind: 'confirm-queue-clear';
      queueVersion: number;
    })
  | (InteractionRequestBase & {
      kind: 'confirm-permission-mode';
      mode: 'strict' | 'normal' | 'auto' | 'yolo';
      generation: number;
    })
  | (InteractionRequestBase & {
      kind: 'tool-approval';
      requestId: number;
      runId: string;
      description: string;
    });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;
export type NewInteractionRequest = DistributiveOmit<InteractionRequest, 'id' | 'createdAt'>;

export type InteractionResponse =
  | { kind: 'confirmed' }
  | { kind: 'cancelled' }
  | { kind: 'selected'; value: string }
  | { kind: 'tool-approval'; action: 'allow_once' | 'allow_session' | 'allow_permanent' | 'deny' };

export type InteractionSettlement =
  | { kind: 'cancelled' }
  | { kind: 'completed'; value: unknown };

export type InteractionExpiryReason =
  | 'session_changed'
  | 'active_run_policy_changed'
  | 'readonly_cap_changed'
  | 'target_changed'
  | 'run_stopped'
  | 'expired';

export class InteractionExpiredError extends Error {
  constructor(readonly reason: InteractionExpiryReason, message: string) {
    super(message);
    this.name = 'InteractionExpiredError';
  }
}

export class InteractionResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractionResponseError';
  }
}

export interface InteractionCoordinatorOptions {
  getState: () => InteractionRuntimeState;
  execute: (request: InteractionRequest, response: InteractionResponse) => Promise<unknown>;
  validateTarget?: (request: InteractionRequest, state: InteractionRuntimeState) => boolean | Promise<boolean>;
  onClosed?: (request: InteractionRequest) => void | Promise<void>;
  createId?: IdGenerator | (() => string);
  now?: () => number;
}

interface RequestRecord {
  request: InteractionRequest;
  status: 'pending' | 'settling' | 'settled' | 'expired';
  expiryReason?: InteractionExpiryReason;
}

export class InteractionCoordinator {
  private readonly recordsById = new Map<string, RequestRecord>();
  private readonly recordsByKey = new Map<string, RequestRecord>();
  private readonly resultsByKey = new Map<string, Promise<InteractionSettlement>>();

  constructor(private readonly options: InteractionCoordinatorOptions) {}

  request(input: NewInteractionRequest): InteractionRequest {
    const existing = this.recordsByKey.get(input.idempotencyKey);
    if (existing !== undefined) return existing.request;

    const id = this.generateId();
    const request = { ...input, id, createdAt: (this.options.now ?? Date.now)() } as InteractionRequest;
    const record: RequestRecord = { request, status: 'pending' };
    this.recordsById.set(id, record);
    this.recordsByKey.set(request.idempotencyKey, record);
    return request;
  }

  listPending(): readonly InteractionRequest[] {
    return [...this.recordsById.values()]
      .filter((record) => record.status === 'pending' || record.status === 'settling')
      .map((record) => record.request);
  }

  settle(id: string, response: InteractionResponse): Promise<InteractionSettlement> {
    const record = this.recordsById.get(id);
    if (record === undefined) {
      return Promise.reject(new InteractionExpiredError('expired', `Unknown or expired interaction request: ${id}`));
    }
    if (record.status === 'expired') {
      return Promise.reject(
        new InteractionExpiredError(record.expiryReason ?? 'expired', `Interaction request is expired: ${id}`),
      );
    }

    const existingResult = this.resultsByKey.get(record.request.idempotencyKey);
    if (existingResult !== undefined) return existingResult;

    record.status = 'settling';
    const result = this.settleOnce(record, response);
    this.resultsByKey.set(record.request.idempotencyKey, result);
    return result;
  }

  expire(predicate: (request: InteractionRequest) => boolean, reason: InteractionExpiryReason = 'expired'): void {
    for (const record of this.recordsById.values()) {
      if (record.status === 'pending' && predicate(record.request)) {
        record.status = 'expired';
        record.expiryReason = reason;
        void this.close(record.request);
      }
    }
  }

  private async settleOnce(record: RequestRecord, response: InteractionResponse): Promise<InteractionSettlement> {
    const { request } = record;
    try {
      const state = this.options.getState();
      revalidateRequest(request, state);
      if (this.options.validateTarget !== undefined && !(await this.options.validateTarget(request, state))) {
        throw new InteractionExpiredError('target_changed', `Interaction target changed: ${request.id}`);
      }
      assertResponseMatches(request, response);
      if (response.kind === 'cancelled') {
        record.status = 'settled';
        return { kind: 'cancelled' };
      }
      const value = await this.options.execute(request, response);
      record.status = 'settled';
      return { kind: 'completed', value };
    } catch (error) {
      if (error instanceof InteractionExpiredError) {
        record.status = 'expired';
        record.expiryReason = error.reason;
      } else {
        record.status = 'settled';
      }
      throw error;
    } finally {
      await this.close(request);
    }
  }

  private close(request: InteractionRequest): Promise<void> {
    return Promise.resolve(this.options.onClosed?.(request)).catch((error) => {
      console.warn('[InteractionCoordinator] Failed to close interaction UI', error);
    });
  }

  private generateId(): string {
    const generator = this.options.createId;
    if (generator === undefined) return createId('interaction');
    return generator.length === 0 ? (generator as () => string)() : (generator as IdGenerator)('interaction');
  }
}

function revalidateRequest(request: InteractionRequest, state: InteractionRuntimeState): void {
  if (request.sessionId !== state.sessionId) {
    throw new InteractionExpiredError('session_changed', `Active session changed before interaction settlement: ${request.id}`);
  }
  if (request.activeRunPolicy === 'reject' && state.activeRunExists) {
    throw new InteractionExpiredError(
      'active_run_policy_changed',
      `Operation ${request.operation} is no longer allowed while a run is active.`,
    );
  }
  if (!request.allowedInReadonly && (state.agentMode === 'plan' || state.reviewActive)) {
    throw new InteractionExpiredError(
      'readonly_cap_changed',
      `Operation ${request.operation} is blocked by the current readonly cap.`,
    );
  }
}

function assertResponseMatches(request: InteractionRequest, response: InteractionResponse): void {
  if (response.kind === 'cancelled') return;
  if (request.kind === 'session-picker' && response.kind === 'selected') return;
  if (request.kind === 'tool-approval' && response.kind === 'tool-approval') return;
  if (request.kind !== 'session-picker' && request.kind !== 'tool-approval' && response.kind === 'confirmed') return;
  throw new InteractionResponseError(`Response ${response.kind} does not match request ${request.kind}.`);
}
