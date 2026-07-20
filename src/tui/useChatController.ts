import { useCallback, useSyncExternalStore } from 'react';

import type { AppRuntime } from '../app/runtime/AppRuntime.js';
import type { InputIntent, InputRouteResult, InputRouter } from '../app/runtime/InputRouter.js';
import type { AppSnapshot } from '../app/runtime/types.js';

export interface UseAppRuntimeResult {
  snapshot: AppSnapshot;
  routeInput(text: string, intent: InputIntent): Promise<InputRouteResult>;
}

/** React only observes the authoritative AppRuntime snapshot and emits input intents. */
export function useAppRuntime(
  runtime: AppRuntime,
  inputRouter: Pick<InputRouter, 'route'>,
): UseAppRuntimeResult {
  const subscribe = useCallback(
    (onStoreChange: () => void) => runtime.subscribe(() => onStoreChange()),
    [runtime],
  );
  const snapshot = useSyncExternalStore(subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const routeInput = useCallback(
    (text: string, intent: InputIntent) => inputRouter.route(text, intent),
    [inputRouter],
  );
  return { snapshot, routeInput };
}
