import { describe, expect, it } from 'vitest';

import { content as actionsContent } from '../../../src/system-prompt/modules/actions.js';
import { content as constraintsContent } from '../../../src/system-prompt/modules/constraints.js';
import { content as identityContent } from '../../../src/system-prompt/modules/identity.js';
import { content as outputContent } from '../../../src/system-prompt/modules/output.js';
import { content as taskModeContent } from '../../../src/system-prompt/modules/taskMode.js';
import { content as toolsContent } from '../../../src/system-prompt/modules/tools.js';
import { defaultRegistry } from '../../../src/system-prompt/registry.js';

// ─── AC14a: 模块 content 不含模板插值 ─────────────────────────────────────

describe('模块内容约束 - 无模板插值', () => {
  const allModuleContents = [
    { id: 'identity', content: identityContent },
    { id: 'constraints', content: constraintsContent },
    { id: 'task-mode', content: taskModeContent },
    { id: 'actions', content: actionsContent },
    { id: 'tools', content: toolsContent },
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

// ─── 安全边界关键内容验证 ─────────────────────────────────────────────────

describe('模块内容约束 - constraints 安全规则', () => {
  it('constraints 包含提示注入防御规则', () => {
    expect(constraintsContent).toContain('忽略');
  });

  it('constraints 包含 secret 保护规则', () => {
    expect(constraintsContent).toMatch(/API key|凭据|secret/);
  });
});
