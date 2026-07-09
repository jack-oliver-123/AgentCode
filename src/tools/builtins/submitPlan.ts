import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolValidationResult } from '../types.js';
import { isRecord } from './validation.js';

interface SubmitPlanInput {
  steps: Array<{ title: string; description: string }>;
}

interface SubmitPlanOutput {
  steps: Array<{ title: string; description: string }>;
}

export function createSubmitPlanTool(): ToolDefinition<SubmitPlanInput, SubmitPlanOutput> {
  return {
    name: 'submit_plan',
    description:
      'Submit a structured plan with ordered steps. Use this tool in Plan Mode to output a step-by-step plan for the user to review before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'string',
          description:
            'JSON array of plan steps. Each element must be an object with "title" and "description" fields. Example: [{"title":"Read config","description":"Check current settings"}]',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    risk: 'read',
    validate: validateSubmitPlanInput,
    execute: executeSubmitPlan,
  };
}

function validateSubmitPlanInput(input: unknown): ToolValidationResult<SubmitPlanInput> {
  if (!isRecord(input)) {
    return invalidArgs('submit_plan arguments must be an object.');
  }

  if (typeof input.steps !== 'string') {
    return invalidArgs('submit_plan.steps must be a JSON string.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.steps);
  } catch {
    return invalidArgs('submit_plan.steps is not valid JSON.');
  }

  if (!Array.isArray(parsed)) {
    return invalidArgs('submit_plan.steps must be a JSON array.');
  }

  if (parsed.length === 0) {
    return invalidArgs('submit_plan.steps must have at least one step.');
  }

  for (let i = 0; i < parsed.length; i++) {
    const step = parsed[i] as unknown;
    if (!isRecord(step)) {
      return invalidArgs(`submit_plan.steps[${i}] must be an object.`);
    }
    if (typeof step.title !== 'string' || step.title.trim().length === 0) {
      return invalidArgs(`submit_plan.steps[${i}].title must be a non-empty string.`);
    }
    if (typeof step.description !== 'string' || step.description.trim().length === 0) {
      return invalidArgs(`submit_plan.steps[${i}].description must be a non-empty string.`);
    }
  }

  return {
    ok: true,
    value: {
      steps: (parsed as Record<string, unknown>[]).map((s) => ({
        title: s.title as string,
        description: s.description as string,
      })),
    },
  };
}

async function executeSubmitPlan(
  input: SubmitPlanInput,
  _context: ToolExecutionContext,
): Promise<ToolExecutionResult<SubmitPlanOutput>> {
  return {
    ok: true,
    toolName: 'submit_plan',
    data: { steps: input.steps },
    meta: { durationMs: 0, timedOut: false },
  };
}

function invalidArgs(message: string): ToolValidationResult<SubmitPlanInput> {
  return {
    ok: false,
    error: {
      code: 'invalid_arguments',
      message,
      retryable: false,
    },
  };
}
