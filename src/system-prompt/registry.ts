import type { SystemPromptModule } from './types.js';
import { content as identityContent } from './modules/identity.js';
import { content as constraintsContent } from './modules/constraints.js';
import { content as gitSafetyContent } from './modules/git-safety.js';
import { content as taskModeContent } from './modules/taskMode.js';
import { content as actionsContent } from './modules/actions.js';
import { content as toolsContent } from './modules/tools.js';
import { content as toneContent } from './modules/tone.js';
import { content as outputContent } from './modules/output.js';

export const defaultRegistry: SystemPromptModule[] = [
  { id: 'identity', order: 100, content: identityContent },
  { id: 'constraints', order: 200, content: constraintsContent },
  { id: 'git-safety', order: 210, content: gitSafetyContent },
  { id: 'task-mode', order: 250, content: taskModeContent },
  { id: 'actions', order: 300, content: actionsContent },
  { id: 'tools', order: 400, content: toolsContent },
  { id: 'tone', order: 500, content: toneContent },
  { id: 'output', order: 600, content: outputContent },
  { id: 'custom-instructions', order: 700, content: '' },
  { id: 'memory', order: 800, content: '' },
];
