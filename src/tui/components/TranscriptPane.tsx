import { Box, Text } from 'ink';
import React, { useEffect, useState, type ReactElement } from 'react';

import type { ChatMessage, ChatSessionDraft } from '../../session/types.js';

const MAX_VISIBLE_MESSAGES = 8;
const MAX_VISIBLE_MESSAGES_WITH_DRAFT = 5;
const MAX_VISIBLE_TEXT_LENGTH = 1200;
const ACTIVITY_FRAME_INTERVAL_MS = 120;
const WAITING_FOR_FIRST_TOKEN_TEXT = 'Waiting for the first token…';
const ACTIVITY_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'] as const;

export interface TranscriptPaneProps {
  messages: ChatMessage[];
  draft?: ChatSessionDraft | undefined;
  showThinking: boolean;
}

interface TranscriptMessageProps {
  message: ChatMessage;
}

interface DraftMessageProps {
  draft: ChatSessionDraft;
  showThinking: boolean;
}

export function TranscriptPane({ messages, draft, showThinking }: TranscriptPaneProps): ReactElement {
  const visibleMessageLimit = draft === undefined ? MAX_VISIBLE_MESSAGES : MAX_VISIBLE_MESSAGES_WITH_DRAFT;
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessageLimit);
  const visibleMessages = messages.slice(-visibleMessageLimit);
  const hasConversation = messages.length > 0 || draft !== undefined;

  return (
    <Box flexDirection="column" marginY={1} flexShrink={1} overflowY="hidden">
      {!hasConversation ? (
        <Box flexDirection="column">
          <Text color="cyan">Ready for a new AgentCode conversation.</Text>
          <Text color="gray">Ask a question about your project or describe what you want to explore.</Text>
        </Box>
      ) : null}
      {hiddenMessageCount > 0 ? <Text color="gray">… {hiddenMessageCount} earlier messages hidden; latest context is shown below</Text> : null}
      {visibleMessages.map((message) => (
        <TranscriptMessage key={message.id} message={message} />
      ))}
      {draft !== undefined ? <DraftMessage draft={draft} showThinking={showThinking} /> : null}
    </Box>
  );
}

function TranscriptMessage({ message }: TranscriptMessageProps): ReactElement {
  const text = truncateText(message.parts.map((part) => part.text).join(''));

  if (message.role === 'user') {
    return (
      <Box marginBottom={1}>
        <Box flexShrink={0} width={2}>
          <Text color="blue">▌</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          <Text color="cyan" wrap="wrap">{text}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box marginBottom={1} paddingLeft={2}>
      <Text wrap="wrap">{text}</Text>
    </Box>
  );
}

function DraftMessage({ draft, showThinking }: DraftMessageProps): ReactElement {
  const frame = useActivityFrame();
  const visibleText = formatDraftVisibleText(draft.visibleText);
  const statusText = formatDraftStatus(draft, showThinking);

  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text color="blue">{frame} {statusText}</Text>
      {draft.activity.type === 'tool' ? null : <Text wrap="wrap">{visibleText}</Text>}
      {showThinking && draft.thinkingText.length > 0 ? (
        <Text color="gray" wrap="wrap">
          Thinking: {truncateText(draft.thinkingText, 'tail')}
        </Text>
      ) : null}
    </Box>
  );
}

function useActivityFrame(): string {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((currentIndex) => (currentIndex + 1) % ACTIVITY_FRAMES.length);
    }, ACTIVITY_FRAME_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  return ACTIVITY_FRAMES[frameIndex] ?? ACTIVITY_FRAMES[0];
}

function formatDraftVisibleText(visibleText: string): string {
  if (visibleText.length === 0) {
    return WAITING_FOR_FIRST_TOKEN_TEXT;
  }

  return truncateText(visibleText, 'tail');
}

function formatDraftStatus(draft: ChatSessionDraft, showThinking: boolean): string {
  if (draft.activity.type === 'tool') {
    return `Using ${draft.activity.toolName}`;
  }

  const hasVisibleText = draft.visibleText.length > 0;
  const hasThinkingText = draft.thinkingText.length > 0;

  if (!hasVisibleText && hasThinkingText) {
    return showThinking ? 'Thinking' : 'Waiting for model response';
  }

  if (!hasVisibleText) {
    return showThinking ? 'Thinking' : 'Waiting for model response';
  }

  return `Writing · ${draft.visibleText.length} chars`;
}

function truncateText(text: string, keep: 'head' | 'tail' = 'head'): string {
  if (text.length <= MAX_VISIBLE_TEXT_LENGTH) {
    return text;
  }

  if (keep === 'tail') {
    return `…${text.slice(-MAX_VISIBLE_TEXT_LENGTH)}`;
  }

  return `${text.slice(0, MAX_VISIBLE_TEXT_LENGTH)}…`;
}
