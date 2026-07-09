import type { ToolJsonSchema, ToolJsonSchemaProperty } from './types.js';

const STRING_PROPERTY = 'string' as const;

export const readFileInputSchema = createObjectSchema(
  {
    path: stringProperty('Workspace-relative path to the text file to read.'),
    maxBytes: numberProperty('Optional maximum number of bytes to return.'),
  },
  ['path'],
);

export const writeFileInputSchema = createObjectSchema(
  {
    path: stringProperty('Workspace-relative path to write.'),
    content: stringProperty('Text content to write.'),
    overwrite: booleanProperty('Whether an existing file may be overwritten.'),
  },
  ['path', 'content'],
);

export const editFileInputSchema = createObjectSchema(
  {
    path: stringProperty('Workspace-relative path to edit.'),
    oldText: stringProperty('Exact original text that must appear exactly once.'),
    newText: stringProperty('Replacement text.'),
  },
  ['path', 'oldText', 'newText'],
);

export const runCommandInputSchema = createObjectSchema(
  {
    command: stringProperty('One-shot non-interactive command to run in the workspace.'),
    timeoutMs: numberProperty('Optional timeout in milliseconds.'),
  },
  ['command'],
);

export const globFilesInputSchema = createObjectSchema(
  {
    pattern: stringProperty('Glob-style pattern to match workspace files.'),
    maxResults: numberProperty('Optional maximum number of matching paths to return.'),
  },
  ['pattern'],
);

export const searchCodeInputSchema = createObjectSchema(
  {
    query: stringProperty('Text or regular expression to search for.'),
    regex: booleanProperty('Whether query should be interpreted as a regular expression.'),
    include: stringProperty('Optional glob-style include pattern.'),
    maxResults: numberProperty('Optional maximum number of matches to return.'),
  },
  ['query'],
);

function createObjectSchema(properties: Record<string, ToolJsonSchemaProperty>, required: string[]): ToolJsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function stringProperty(description: string): ToolJsonSchemaProperty {
  return {
    type: STRING_PROPERTY,
    description,
  };
}

function numberProperty(description: string): ToolJsonSchemaProperty {
  return {
    type: 'number',
    description,
  };
}

function booleanProperty(description: string): ToolJsonSchemaProperty {
  return {
    type: 'boolean',
    description,
  };
}
