import type { AskPermissionFn, PromptResponse } from '../tools/permissions/types.js';

const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;

export interface PermissionPromptSnapshot {
  id: number;
  toolName: string;
  description: string;
}

export interface PermissionPromptCoordinator {
  askPermission: AskPermissionFn;
  getSnapshot(): PermissionPromptSnapshot | undefined;
  subscribe(listener: () => void): () => void;
  respond(requestId: number, response: PromptResponse): void;
  dispose(): void;
}

interface PendingRequest {
  snapshot: PermissionPromptSnapshot;
  resolve(response: PromptResponse): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

export function createPermissionPromptCoordinator(
  timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
): PermissionPromptCoordinator {
  const listeners = new Set<() => void>();
  const queue: PendingRequest[] = [];
  let snapshot: PermissionPromptSnapshot | undefined;
  let disposed = false;
  let nextRequestId = 1;

  const askPermission: AskPermissionFn = (input, description) => {
    if (disposed) {
      return Promise.resolve({ action: 'deny' });
    }

    return new Promise<PromptResponse>((resolve) => {
      queue.push({
        snapshot: { id: nextRequestId++, toolName: input.toolName, description },
        resolve,
        timer: undefined,
        settled: false,
      });
      activateNext();
    });
  };

  function getSnapshot(): PermissionPromptSnapshot | undefined {
    return snapshot;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function respond(requestId: number, response: PromptResponse): void {
    if (queue[0]?.snapshot.id !== requestId) {
      return;
    }
    settleActive(response);
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;

    while (queue.length > 0) {
      const request = queue.shift();
      if (request !== undefined) {
        settle(request, { action: 'deny' });
      }
    }
    updateSnapshot(undefined);
  }

  function activateNext(): void {
    if (snapshot !== undefined || disposed) {
      return;
    }

    const request = queue[0];
    if (request === undefined) {
      return;
    }

    request.timer = setTimeout(() => settleActive({ action: 'deny' }), timeoutMs);
    updateSnapshot(request.snapshot);
  }

  function settleActive(response: PromptResponse): void {
    const request = queue.shift();
    if (request === undefined) {
      return;
    }

    settle(request, response);
    updateSnapshot(undefined);
    activateNext();
  }

  function settle(request: PendingRequest, response: PromptResponse): void {
    if (request.settled) {
      return;
    }
    request.settled = true;
    if (request.timer !== undefined) {
      clearTimeout(request.timer);
      request.timer = undefined;
    }
    request.resolve(response);
  }

  function updateSnapshot(next: PermissionPromptSnapshot | undefined): void {
    if (snapshot === next) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  }

  return { askPermission, getSnapshot, subscribe, respond, dispose };
}
