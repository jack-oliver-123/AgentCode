export type ToolRisk = 'read' | 'write' | 'execute';

export type ToolJsonSchema = {
  type: 'object';
  properties: Record<string, ToolJsonSchemaProperty>;
  required?: string[];
  additionalProperties: boolean;
};

/**
 * 工具 schema 属性类型。仅支持标量类型（string/number/boolean）。
 * 如果工具需要接收数组/对象，请将参数声明为 string 类型，
 * 由模型传入 JSON 字符串，在 validate 函数中 JSON.parse 并校验结构。
 * 参考实现：src/tools/builtins/submitPlan.ts
 */
export type ToolJsonSchemaProperty =
  | {
      type: 'string';
      description: string;
    }
  | {
      type: 'number' | 'boolean';
      description: string;
    };

export type ToolValidationResult<TInput> =
  | {
      ok: true;
      value: TInput;
    }
  | {
      ok: false;
      error: ToolExecutionError;
    };

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  risk: ToolRisk;
  validate(input: unknown): ToolValidationResult<TInput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolExecutionResult<TOutput>>;
}

export interface ToolRegistry {
  list(): readonly ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  getProviderDeclarations(): ProviderToolDeclaration[];
  /** 按 risk 过滤，返回只含指定 risk 级别工具的新 registry */
  filterByRisk(allowedRisks: ToolRisk[]): ToolRegistry;
}

export interface ProviderToolDeclaration {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export interface ToolExecutionContext {
  cwd: string;
  timeoutMs: number;
  secrets: readonly string[];
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type ToolExecutionResult<TData = unknown> =
  | {
      ok: true;
      toolName: string;
      data: TData;
      meta: ToolExecutionMeta;
    }
  | {
      ok: false;
      toolName: string;
      error: ToolExecutionError;
      meta: ToolExecutionMeta;
    };

export interface ToolExecutionMeta {
  durationMs: number;
  timedOut: boolean;
  truncated?: boolean;
}

export interface ToolExecutionError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ToolErrorCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'path_outside_workspace'
  | 'file_not_found'
  | 'file_not_text'
  | 'file_too_large'
  | 'not_unique_match'
  | 'permission_denied'
  | 'command_failed'
  | 'command_timeout'
  | 'output_too_large'
  | 'tool_internal_error';
