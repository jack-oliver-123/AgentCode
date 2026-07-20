import type { CommandContext } from '../context.js';
import { CommandError } from '../errors.js';
import type { CommandAction, CommandDefinition, CommandResult } from '../types.js';
import type { BuiltinOperation } from './operations.js';

export function handleBuiltin(
  context: CommandContext,
  operation: BuiltinOperation,
  commands: readonly CommandDefinition[],
): CommandResult {
  const key = (suffix: string): string => `${context.executionId}:${suffix}`;
  switch (operation.kind) {
    case 'help.open':
      return handled({
        type: 'open_panel', idempotencyKey: key('help'),
        panel: { id: key('help-panel'), kind: 'help', title: 'Commands', data: commands.filter((command) => !command.metadata.hidden).map((command) => command.metadata) },
      });
    case 'help.detail': {
      const command = commands.find((candidate) =>
        [candidate.metadata.name, ...candidate.metadata.aliases].some((name) => name.toLocaleLowerCase() === operation.command),
      );
      return command === undefined || command.metadata.hidden
        ? rejected('unknown_command', `未知命令 /${operation.command}。使用 /help 查看可用命令。`)
        : handled({
            type: 'open_panel', idempotencyKey: key('help-detail'),
            panel: { id: key('help-detail-panel'), kind: 'help', title: `/${command.metadata.name}`, data: command.metadata },
          });
    }
    case 'compact':
      return handled({ type: 'compact', idempotencyKey: key('compact'), ...(operation.instructions !== undefined ? { instructions: operation.instructions } : {}) });
    case 'clear':
      return handled({ type: 'create_session', idempotencyKey: key('clear'), ...(operation.name !== undefined ? { name: operation.name } : {}) });
    case 'mode.plan':
      return handled(
        { type: 'set_agent_mode', idempotencyKey: key('mode'), mode: 'plan' },
        ...(operation.prompt !== undefined
          ? [{ type: 'submit_prompt' as const, idempotencyKey: key('prompt'), text: operation.prompt, agentMode: 'plan' as const }]
          : []),
      );
    case 'mode.default':
      return handled(
        { type: 'set_agent_mode', idempotencyKey: key('mode'), mode: 'default' },
        ...(operation.prompt !== undefined
          ? [{ type: 'submit_prompt' as const, idempotencyKey: key('prompt'), text: operation.prompt, agentMode: 'default' as const }]
          : []),
      );
    case 'session.picker':
      return handled({
        type: 'open_interaction',
        idempotencyKey: key('sessions'),
        request: {
          kind: 'session-picker',
          idempotencyKey: key('session-picker'),
          sessionId: context.session.id,
          operation: 'session.picker',
          activeRunPolicy: 'reject',
          allowedInReadonly: false,
          choices: context.sessions,
        },
      });
    case 'session.current':
      return handled({ type: 'append_command_output', idempotencyKey: key('session-current'), command: 'session', content: JSON.stringify({ ...context.session, queueCount: context.queue.items.length }, null, 2) });
    case 'session.resume':
      return handled({ type: 'activate_session', idempotencyKey: key('session-resume'), sessionId: operation.target });
    case 'session.rename':
      return handled({ type: 'rename_session', idempotencyKey: key('session-rename'), sessionId: context.session.id, name: operation.name });
    case 'memory.picker':
      return handled({
        type: 'open_panel', idempotencyKey: key('memory'),
        panel: { id: key('memory-panel'), kind: 'memory', title: 'Memory', data: context.memory },
      });
    case 'memory.status':
      return handled({ type: 'append_command_output', idempotencyKey: key('memory-status'), command: 'memory', content: JSON.stringify(context.memory.status, null, 2) });
    case 'memory.show':
      return handled({ type: 'show_memory', idempotencyKey: key('memory-show'), scope: operation.scope, entry: operation.entry });
    case 'memory.delete':
      return handled({ type: 'request_memory_delete', idempotencyKey: key('memory-delete'), scope: operation.scope, entry: operation.entry });
    case 'permission.panel':
      return handled({
        type: 'open_panel', idempotencyKey: key('permission'),
        panel: { id: key('permission-panel'), kind: 'permission', title: 'Permissions', data: { snapshot: context.permissions, rules: context.permissionRules } },
      });
    case 'permission.status':
      return handled({ type: 'append_command_output', idempotencyKey: key('permission-status'), command: 'permission', content: JSON.stringify(context.permissions, null, 2) });
    case 'permission.mode':
      return handled({ type: 'set_permission_mode', idempotencyKey: key('permission-mode'), mode: operation.mode });
    case 'permission.rules':
      return handled({
        type: 'open_panel', idempotencyKey: key('permission-rules'),
        panel: { id: key('permission-rules-panel'), kind: 'permission', title: 'Permission rules', data: operation.scope === undefined ? context.permissionRules : context.permissionRules.filter((rule) => rule.scope === operation.scope) },
      });
    case 'permission.remove': {
      const rule = context.permissionRules.find(
        (candidate) => candidate.scope === operation.scope && candidate.id === operation.ruleId,
      );
      return rule === undefined
        ? rejected('target_changed', `权限规则不存在或已变化：${operation.ruleId}`)
        : handled({
            type: 'request_permission_rule_remove',
            idempotencyKey: key('permission-remove'),
            scope: operation.scope,
            ruleId: operation.ruleId,
            expectedGeneration: context.permissions.generation,
            expectedFingerprint: rule.fingerprint,
          });
    }
    case 'status.open':
      return handled({ type: 'open_panel', idempotencyKey: key('status'), panel: { id: key('status-panel'), kind: 'status', title: 'Status', data: context.status } });
    case 'review.worktree':
      return handled({ type: 'start_review', idempotencyKey: key('review'), target: { kind: 'worktree', ...(operation.focus !== undefined ? { focus: operation.focus } : {}) } });
    case 'review.branch':
      return handled({ type: 'start_review', idempotencyKey: key('review'), target: { kind: 'branch', branch: operation.branch, ...(operation.focus !== undefined ? { focus: operation.focus } : {}) } });
    case 'review.pr':
      return handled({ type: 'start_review', idempotencyKey: key('review'), target: { kind: 'pr', target: operation.target, ...(operation.focus !== undefined ? { focus: operation.focus } : {}) } });
    case 'stop':
      return context.app.run.phase === 'idle'
        ? rejected('no_active_run', '当前没有可停止的运行。')
        : handled({ type: 'stop_run', idempotencyKey: key('stop') });
    case 'steer':
      return context.app.run.phase === 'idle'
        ? rejected('no_active_run', '当前没有可接收 Steer 的运行。')
        : handled({ type: 'steer', idempotencyKey: key('steer'), text: operation.text });
    case 'queue.add':
      return handled({ type: 'queue_add', idempotencyKey: key('queue-add'), text: operation.text });
    case 'queue.list':
      return handled({ type: 'append_command_output', idempotencyKey: key('queue-list'), command: 'queue', content: JSON.stringify(context.queue, null, 2) });
    case 'queue.run':
      return handled({ type: 'queue_run', idempotencyKey: key('queue-run') });
    case 'queue.remove':
      return handled({ type: 'request_queue_remove', idempotencyKey: key('queue-remove'), index: operation.index, expectedVersion: context.queue.version });
    case 'queue.clear':
      return handled({ type: 'request_queue_clear', idempotencyKey: key('queue-clear'), expectedVersion: context.queue.version });
  }
}

function handled(...actions: CommandAction[]): CommandResult {
  return { kind: 'handled', actions };
}

function rejected(code: ConstructorParameters<typeof CommandError>[0], message: string): CommandResult {
  return { kind: 'rejected', error: new CommandError(code, message) };
}
