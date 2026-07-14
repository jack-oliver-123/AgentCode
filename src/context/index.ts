export { ContextManager } from './ContextManager.js';
export type { ContextManagerOptions } from './ContextManager.js';
export {
  NORMAL_MARGIN,
  USER_MESSAGES_PLACEHOLDER,
  countSummaryTurns,
  createEmergencyMessages,
  createFileRecoveryMessage,
  createSkillRecoveryMessage,
  createSummaryMessages,
  dropOldestTurns,
  finalizeSummary,
  renderVerbatimUserMessages,
  selectCompactionLevel,
  splitCompleteTurns,
} from './compaction.js';
export type {
  CompactionLevel,
  CompactionRequest,
  CompactionResult,
  CompactionTrigger,
  CompleteTurn,
  SkillContextSource,
  SkillDefinitionSnapshot,
} from './compaction.js';
export { lookupContextWindow } from './contextWindow.js';
