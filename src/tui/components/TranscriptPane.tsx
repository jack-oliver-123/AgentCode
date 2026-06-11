import { Box, Text } from 'ink';
import React from 'react';

import type { ChatMessage, ChatSessionDraft } from '../../session/types.js';

const MAX_VISIBLE_MESSAGES = 8;
const MAX_VISIBLE_TEXT_LENGTH = 1200;

export interface TranscriptPaneProps {
  messages: ChatMessage[];
  draft?: ChatSessionDraft | undefined;
  showThinking: boolean;
}

export function TranscriptPane({ messages, draft, showThinking }: TranscriptPaneProps) {
  const hiddenMessageCount = Math.max(0, messages.length - MAX_VISIBLE_MESSAGES);
  const visibleMessages = messages.slice(-MAX_VISIBLE_MESSAGES);

  return (
    <Box flexDirection="column" marginY={1} flexShrink={1} overflowY="hidden">
      {messages.length === 0 ? <Text color="gray">Start a conversation by typing below.</Text> : null}
      {hiddenMessageCount > 0 ? <Text color="gray">… {hiddenMessageCount} earlier messages hidden</Text> : null}
      {visibleMessages.map((message) => (
        <Box key={message.id} flexDirection="column" marginBottom={1}>
          <Text color={message.role === 'user' ? 'green' : 'magenta'}>{message.role === 'user' ? 'You' : 'AgentCode'}:</Text>
          <Text wrap="wrap">{truncateText(message.parts.map((part) => part.text).join(''))}</Text>
        </Box>
      ))}
      {draft !== undefined ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="magenta">AgentCode:</Text>
          <Text wrap="wrap">{truncateText(draft.visibleText, 'tail')}</Text>
          {showThinking && draft.thinkingText.length > 0 ? (
            <Text color="gray" wrap="wrap">
              Thinking: {truncateText(draft.thinkingText, 'tail')}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
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
