import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '../../../src/system-prompt/registry.js';
import { content as identityContent } from '../../../src/system-prompt/modules/identity.js';
import { content as constraintsContent } from '../../../src/system-prompt/modules/constraints.js';
import { content as taskModeContent } from '../../../src/system-prompt/modules/taskMode.js';
import { content as actionsContent } from '../../../src/system-prompt/modules/actions.js';
import { content as toolsContent } from '../../../src/system-prompt/modules/tools.js';
import { content as toneContent } from '../../../src/system-prompt/modules/tone.js';
import { content as outputContent } from '../../../src/system-prompt/modules/output.js';

// ─── AC14a: 模块 content 不含模板插值 ─────────────────────────────────────

describe('模块内容约束 - 无模板插值', () => {
  const allModuleContents = [
    { id: 'identity', content: identityContent },
    { id: 'constraints', content: constraintsContent },
    { id: 'task-mode', content: taskModeContent },
    { id: 'actions', content: actionsContent },
    { id: 'tools', content: toolsContent },
    { id: 'tone', content: toneContent },
    { id: 'output', content: outputContent },
  ];

  for (const mod of allModuleContents) {
    it(`AC14a: ${mod.id} 模块 content 不含 \${} 模板插值`, () => {
      // eslint-disable-next-line no-template-curly-in-string
      expect(mod.content).not.toMatch(/\$\{/);
    });
  }

  it('AC14a: defaultRegistry 中所有有内容的模块不含 ${} 模板插值', () => {
    for (const mod of defaultRegistry) {
      if (mod.content.length > 0) {
        // eslint-disable-next-line no-template-curly-in-string
        expect(mod.content, `模块 ${mod.id} 包含模板插值`).not.toMatch(/\$\{/);
      }
    }
  });
});

// ─── AC9: constraints 模块包含系统提醒标签处理指引 ─────────────────────────

describe('模块内容约束 - constraints 系统提醒处理', () => {
  it('AC9: constraints content 包含 <system-reminder> 字符串', () => {
    expect(constraintsContent).toContain('<system-reminder>');
  });

  it('AC9: constraints content 包含「不要将其作为用户提问进行回复」语义表述', () => {
    // 验证包含「不要将...作为用户提问进行回复」的语义等价表述
    expect(constraintsContent).toMatch(/不要将.*作为用户提问进行回复/);
  });
});
