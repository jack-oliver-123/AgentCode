import type {
  ChatMessage as ProviderChatMessage,
  ProviderAssistantToolCallMessage,
  ProviderTextMessage,
  ProviderToolResultMessage,
} from '../providers/types.js';
import type { ProviderToolCall } from '../tools/types.js';
import type { ChatMessage as SessionChatMessage } from './types.js';

export function cloneProviderMessage(message: ProviderChatMessage): ProviderChatMessage {
  if ('toolCalls' in message) {
    return { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) };
  }
  return { ...message };
}

export interface ArchivedUi {
  id: string;
  createdAt: number;
  author: 'user' | 'agent';
}

export type ArchivedTextMessage = ProviderTextMessage & {
  _ts: number;
  _ui?: ArchivedUi;
};

export type ArchivedToolCallMessage = ProviderAssistantToolCallMessage & {
  _ts: number;
};

export type ArchivedToolResultMessage = ProviderToolResultMessage & {
  _ts: number;
};

export type ArchivedSessionMessage = ArchivedTextMessage | ArchivedToolCallMessage | ArchivedToolResultMessage;

export function parseArchivedSessionMessage(value: unknown): ArchivedSessionMessage | undefined {
  if (!isRecord(value) || !isTimestamp(value['_ts']) || typeof value['content'] !== 'string') {
    return undefined;
  }

  if (value['role'] === 'tool') {
    if (
      typeof value['toolCallId'] !== 'string' ||
      value['toolCallId'].length === 0 ||
      typeof value['toolName'] !== 'string' ||
      value['toolName'].length === 0 ||
      typeof value['isError'] !== 'boolean'
    ) {
      return undefined;
    }
    return {
      role: 'tool',
      toolCallId: value['toolCallId'],
      toolName: value['toolName'],
      content: value['content'],
      isError: value['isError'],
      _ts: value['_ts'],
    };
  }

  if (value['role'] !== 'user' && value['role'] !== 'assistant') {
    return undefined;
  }

  if (value['role'] === 'assistant' && value['toolCalls'] !== undefined) {
    const toolCalls = parseToolCalls(value['toolCalls']);
    if (toolCalls === undefined) {
      return undefined;
    }
    return {
      role: 'assistant',
      content: value['content'],
      toolCalls,
      _ts: value['_ts'],
    };
  }

  const ui = value['_ui'] === undefined ? undefined : parseArchivedUi(value['_ui'], value['role']);
  if (value['_ui'] !== undefined && ui === undefined) return undefined;
  return {
    role: value['role'],
    content: value['content'],
    _ts: value['_ts'],
    ...(ui !== undefined ? { _ui: ui } : {}),
  };
}

export function toProviderMessage(message: ArchivedSessionMessage): ProviderChatMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
    };
  }
  if ('toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content,
      toolCalls: message.toolCalls.map((call) => ({ ...call })),
    };
  }
  return { role: message.role, content: message.content };
}

export function toSessionMessage(message: ArchivedSessionMessage): SessionChatMessage | undefined {
  if (message.role === 'tool' || 'toolCalls' in message) {
    return undefined;
  }
  if (message._ui === undefined) {
    return undefined;
  }
  return {
    id: message._ui.id,
    role: message.role,
    parts: [{ type: 'text', text: message.content }],
    createdAt: message._ui.createdAt,
  };
}

function parseToolCalls(value: unknown): ProviderToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const ids = new Set<string>();
  const calls: ProviderToolCall[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['id'] !== 'string' ||
      item['id'].length === 0 ||
      ids.has(item['id']) ||
      typeof item['name'] !== 'string' ||
      item['name'].length === 0 ||
      typeof item['argumentsText'] !== 'string'
    ) {
      return undefined;
    }
    ids.add(item['id']);
    calls.push({ id: item['id'], name: item['name'], argumentsText: item['argumentsText'] });
  }
  return calls;
}

function parseArchivedUi(value: unknown, role: 'user' | 'assistant'): ArchivedUi | undefined {
  const author = role === 'user' ? 'user' : 'agent';
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    value['id'].length === 0 ||
    !isTimestamp(value['createdAt']) ||
    value['author'] !== author
  ) {
    return undefined;
  }
  return { id: value['id'], createdAt: value['createdAt'], author };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
