import type { CommandDispatcher } from '../../commands/dispatcher.js';
import type { CommandParser } from '../../commands/parser.js';
import type { CommandDefinition } from '../../commands/types.js';
import type { AppSnapshot } from './types.js';

export type InputIntent = 'enter' | 'alt-enter' | 'tab' | 'shift-tab';

export type RouteAcceptance =
  | { accepted: true }
  | { accepted: false; reason: string };

export interface InputWorkspacePort {
  submitPrompt(text: string): Promise<RouteAcceptance>;
  steer(text: string): Promise<RouteAcceptance>;
  queueAdd(text: string): Promise<RouteAcceptance>;
}

export interface CompletionResult {
  text: string;
  candidates: readonly string[];
  direction: 'next' | 'previous';
  selectedIndex?: number;
}

export interface InputRouterOptions {
  parser: CommandParser<CommandDefinition>;
  dispatcher: Pick<CommandDispatcher, 'dispatch'>;
  workspace: InputWorkspacePort;
  reviewSteer?: (text: string) => Promise<RouteAcceptance>;
  getAppSnapshot: () => AppSnapshot;
  complete: (text: string, direction: 'next' | 'previous') => CompletionResult;
  getCompletionCandidates?: (text: string) => readonly string[];
  resetCompletion?: () => void;
  toggleMode: () => Promise<RouteAcceptance>;
  onCommandResult?: (result: Awaited<ReturnType<CommandDispatcher['dispatch']>>) => void;
  onError?: (error: unknown) => void;
  onAccepted?: () => void;
}

export type InputRouteResult =
  | { kind: 'empty'; accepted: false; clearInput: false }
  | {
      kind: 'completion';
      accepted: false;
      clearInput: false;
      input: string;
      candidates?: readonly string[];
      selectedIndex?: number;
    }
  | { kind: 'mode_toggle'; accepted: boolean; clearInput: false; reason?: string }
  | { kind: 'command'; accepted: boolean; clearInput: boolean; result: Awaited<ReturnType<CommandDispatcher['dispatch']>> }
  | { kind: 'prompt' | 'steer' | 'queue'; accepted: boolean; clearInput: boolean; reason?: string }
  | { kind: 'error'; accepted: false; clearInput: false; error: unknown };

export class InputRouter {
  constructor(private readonly options: InputRouterOptions) {}

  resetCompletion(): void {
    this.options.resetCompletion?.();
  }

  async route(rawText: string, intent: InputIntent): Promise<InputRouteResult> {
    if (intent === 'tab') return this.complete(rawText, 'next');
    if (intent === 'shift-tab') {
      return rawText.trimStart().startsWith('/')
        ? this.complete(rawText, 'previous')
        : this.toggleMode();
    }

    const text = rawText.trim();
    if (text.length === 0) return { kind: 'empty', accepted: false, clearInput: false };

    if (text.startsWith('/')) {
      let parsed: ReturnType<CommandParser<CommandDefinition>['parse']>;
      try {
        parsed = this.options.parser.parse(rawText);
      } catch (error) {
        this.options.onError?.(error);
        return { kind: 'error', accepted: false, clearInput: false, error };
      }
      if (parsed.kind === 'completion') {
        const candidates = this.options.getCompletionCandidates?.('/') ?? this.options.complete('/', 'next').candidates;
        return { kind: 'completion', accepted: false, clearInput: false, input: '/', candidates };
      }
      if (parsed.kind === 'error') {
        this.options.onError?.(parsed.error);
        return { kind: 'error', accepted: false, clearInput: false, error: parsed.error };
      }
      if (parsed.kind !== 'command') {
        const error = new Error('Invalid slash input.');
        this.options.onError?.(error);
        return { kind: 'error', accepted: false, clearInput: false, error };
      }
      const result = await this.options.dispatcher.dispatch(parsed.input);
      this.options.onCommandResult?.(result);
      return {
        kind: 'command',
        accepted: result.consumed,
        clearInput: result.consumed,
        result,
      };
    }

    const app = this.options.getAppSnapshot();
    if (intent === 'alt-enter') return this.routeWorkspace('queue', text, this.options.workspace.queueAdd.bind(this.options.workspace));
    if (app.run.phase !== 'idle' || app.queue.draining) {
      const steer = app.run.reviewActive && this.options.reviewSteer !== undefined
        ? this.options.reviewSteer
        : this.options.workspace.steer.bind(this.options.workspace);
      return this.routeWorkspace('steer', text, steer);
    }
    return this.routeWorkspace('prompt', text, this.options.workspace.submitPrompt.bind(this.options.workspace));
  }

  private complete(text: string, direction: 'next' | 'previous'): InputRouteResult {
    const completion = this.options.complete(text, direction);
    return {
      kind: 'completion',
      accepted: false,
      clearInput: false,
      input: completion.text,
      candidates: completion.candidates,
      ...(completion.selectedIndex !== undefined ? { selectedIndex: completion.selectedIndex } : {}),
    };
  }

  private async toggleMode(): Promise<InputRouteResult> {
    try {
      const result = await this.options.toggleMode();
      if (result.accepted) this.options.onAccepted?.();
      else this.options.onError?.(new Error(result.reason));
      return {
        kind: 'mode_toggle',
        accepted: result.accepted,
        clearInput: false,
        ...(!result.accepted ? { reason: result.reason } : {}),
      };
    } catch (error) {
      this.options.onError?.(error);
      return { kind: 'mode_toggle', accepted: false, clearInput: false, reason: errorMessage(error) };
    }
  }

  private async routeWorkspace(
    kind: 'prompt' | 'steer' | 'queue',
    text: string,
    route: (text: string) => Promise<RouteAcceptance>,
  ): Promise<InputRouteResult> {
    try {
      const result = await route(text);
      if (result.accepted) this.options.onAccepted?.();
      else this.options.onError?.(new Error(result.reason));
      return {
        kind,
        accepted: result.accepted,
        clearInput: result.accepted,
        ...(!result.accepted ? { reason: result.reason } : {}),
      };
    } catch (error) {
      this.options.onError?.(error);
      return { kind, accepted: false, clearInput: false, reason: errorMessage(error) };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
