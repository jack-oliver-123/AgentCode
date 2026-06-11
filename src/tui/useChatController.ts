import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatSessionController } from '../session/ChatSessionController.js';
import type { ChatSessionState } from '../session/types.js';

export interface UseChatControllerResult {
  state: ChatSessionState;
  submitText(text: string): void;
}

export function useChatController(controller: ChatSessionController): UseChatControllerResult {
  const [state, setState] = useState(() => controller.getState());
  const activeTurnAbortController = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);

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

  return {
    state,
    submitText
  };
}
