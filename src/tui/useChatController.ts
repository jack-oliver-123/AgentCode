import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatSessionController } from '../session/ChatSessionController.js';
import type { ChatSessionState } from '../session/types.js';

const NOTICE_AUTO_DISMISS_MS = 3000;

export interface UseChatControllerResult {
  state: ChatSessionState;
  submitText(text: string): void;
  toggleMode(): void;
}

export function useChatController(controller: ChatSessionController): UseChatControllerResult {
  const [state, setState] = useState(() => controller.getState());
  const activeTurnAbortController = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const noticeDismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setState(controller.getState());

    return () => {
      if (generation.current === currentGeneration) {
        generation.current += 1;
      }

      activeTurnAbortController.current?.abort();
      activeTurnAbortController.current = undefined;

      if (noticeDismissTimer.current !== undefined) {
        clearTimeout(noticeDismissTimer.current);
        noticeDismissTimer.current = undefined;
      }
    };
  }, [controller]);

  const submitText = useCallback(
    (text: string) => {
      const turnGeneration = generation.current;
      const turnAbortController = new AbortController();
      activeTurnAbortController.current = turnAbortController;

      void (async () => {
        try {
          for await (const event of controller.submitUserText(text, { signal: turnAbortController.signal })) {
            if (generation.current === turnGeneration) {
              setState(event.state);
            }
          }
        } finally {
          if (activeTurnAbortController.current === turnAbortController) {
            activeTurnAbortController.current = undefined;
          }
        }
      })();
    },
    [controller]
  );

  const toggleMode = useCallback(() => {
    const event = controller.toggleMode();
    setState(event.state);

    // 自动消除 notice
    if (noticeDismissTimer.current !== undefined) {
      clearTimeout(noticeDismissTimer.current);
    }
    noticeDismissTimer.current = setTimeout(() => {
      noticeDismissTimer.current = undefined;
      setState((prev) => {
        if (prev.notice === undefined) return prev;
        const { notice: _, ...rest } = prev;
        return rest as typeof prev;
      });
    }, NOTICE_AUTO_DISMISS_MS);
  }, [controller]);

  return {
    state,
    submitText,
    toggleMode
  };
}
