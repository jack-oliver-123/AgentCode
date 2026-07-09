import { describe, expect, it } from 'vitest';

import { createDefaultToolRegistry } from '../../../src/tools/registry.js';

const EXPECTED_TOOL_SCHEMAS = {
  read_file: {
    required: ['path'],
    properties: ['path', 'maxBytes'],
  },
  write_file: {
    required: ['path', 'content'],
    properties: ['path', 'content', 'overwrite'],
  },
  edit_file: {
    required: ['path', 'oldText', 'newText'],
    properties: ['path', 'oldText', 'newText'],
  },
  run_command: {
    required: ['command'],
    properties: ['command', 'timeoutMs'],
  },
  glob_files: {
    required: ['pattern'],
    properties: ['pattern', 'maxResults'],
  },
  search_code: {
    required: ['query'],
    properties: ['query', 'regex', 'include', 'maxResults'],
  },
} as const;

const EXPECTED_TOOL_NAMES = Object.keys(EXPECTED_TOOL_SCHEMAS);

describe('createDefaultToolRegistry', () => {
  it('registers the built-in task04 tools', () => {
    const registry = createDefaultToolRegistry();

    expect(registry.list().map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    for (const toolName of EXPECTED_TOOL_NAMES) {
      expect(registry.get(toolName)?.name).toBe(toolName);
    }
  });

  it('returns undefined for unknown tools', () => {
    const registry = createDefaultToolRegistry();

    expect(registry.get('unknown_tool')).toBeUndefined();
  });

  it('exports provider declarations without executable implementations', () => {
    const registry = createDefaultToolRegistry();

    const declarations = registry.getProviderDeclarations();

    expect(declarations).toHaveLength(EXPECTED_TOOL_NAMES.length);
    for (const declaration of declarations) {
      expect(EXPECTED_TOOL_NAMES).toContain(declaration.name);
      expect(declaration.description.length).toBeGreaterThan(0);
      expect(declaration.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(declaration).not.toHaveProperty('execute');
      expect(declaration).not.toHaveProperty('validate');
    }
  });

  it('exports the expected parameter contracts for each tool', () => {
    const registry = createDefaultToolRegistry();

    for (const declaration of registry.getProviderDeclarations()) {
      const expectedSchema = EXPECTED_TOOL_SCHEMAS[declaration.name as keyof typeof EXPECTED_TOOL_SCHEMAS];
      expect(declaration.inputSchema.required).toEqual(expectedSchema.required);
      expect(Object.keys(declaration.inputSchema.properties)).toEqual(expectedSchema.properties);
    }
  });
});
