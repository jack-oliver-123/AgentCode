import { DEFAULT_AGENT_LOOP_CONFIG, type AgentLoopEvent, type SteerGuidance } from '../../agent/types.js';
import { runAgentLoop } from '../../agent/AgentLoop.js';
import type { ChatModelProvider } from '../../providers/types.js';
import { AgentCodeError } from '../../shared/errors.js';
import { createStaticRegistry } from '../../tools/registry.js';
import type { ToolExecutionContext, ToolRegistry } from '../../tools/types.js';
import type { FrozenReviewTarget } from './targetFreeze.js';

const REVIEW_SYSTEM_PROMPT = `你是独立代码审查器。只能审查给定的冻结 diff，并且始终保持只读。
只报告会造成错误行为、数据损失、安全问题、测试失败或误导结果的问题；不要报告风格、命名或纯优化建议。
最终只返回 JSON：{"findings":[{"severity":"critical|high|medium|low","file":"path","line":1,"title":"...","scenario":"...","evidence":"..."}],"summary":"..."}。
允许 findings 为空数组。不得调用或请求任何写入工具。`;

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  line?: number;
  title: string;
  scenario: string;
  evidence: string;
}

export interface ReviewResult {
  target: Omit<FrozenReviewTarget, 'diff'>;
  findings: readonly ReviewFinding[];
  summary: string;
}

export interface ReviewRunnerOptions {
  provider: ChatModelProvider;
  model: string;
  toolRegistry: ToolRegistry;
  createToolContext: (signal?: AbortSignal) => ToolExecutionContext;
  validateTarget: (target: FrozenReviewTarget) => Promise<void>;
  persistResult: (result: ReviewResult) => Promise<void>;
  systemPrompt?: string;
}

export class ReviewOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewOutputError';
  }
}

export class ReviewRunner {
  constructor(private readonly options: ReviewRunnerOptions) {}

  async run(
    target: FrozenReviewTarget,
    signal?: AbortSignal,
    consumeSteer?: () => readonly SteerGuidance[],
  ): Promise<ReviewResult> {
    await this.options.validateTarget(target);
    // The frozen diff is the complete review input. Runtime-backed read tools would
    // observe a different checkout and could escape the frozen target boundary.
    const registry = createStaticRegistry([]);
    let finalText: string | undefined;

    const events = runAgentLoop(
      {
        contextMessages: [],
        userMessage: { role: 'user', content: buildReviewPrompt(target) },
        mode: 'default',
        ...(signal !== undefined ? { signal } : {}),
        ...(consumeSteer !== undefined ? { consumeSteer } : {}),
      },
      {
        provider: this.options.provider,
        toolRegistry: registry,
        createToolContext: this.options.createToolContext,
        config: DEFAULT_AGENT_LOOP_CONFIG,
        model: this.options.model,
        thinking: { enabled: false },
        system: this.options.systemPrompt ?? REVIEW_SYSTEM_PROMPT,
      },
    );

    for await (const event of events) {
      finalText = consumeReviewEvent(event, finalText);
    }
    if (finalText === undefined) throw new ReviewOutputError('Review operation ended without a completed response.');

    const parsed = parseReviewOutput(finalText);
    const result: ReviewResult = {
      target: summarizeTarget(target),
      findings: parsed.findings,
      summary: parsed.summary,
    };
    await this.options.persistResult(result);
    return result;
  }
}

function summarizeTarget(target: FrozenReviewTarget): Omit<FrozenReviewTarget, 'diff'> {
  return {
    kind: target.kind,
    input: target.input,
    repoRoot: target.repoRoot,
    ...(target.repoIdentity !== undefined ? { repoIdentity: target.repoIdentity } : {}),
    baseSha: target.baseSha,
    headSha: target.headSha,
    diffHash: target.diffHash,
    ...(target.focus !== undefined ? { focus: target.focus } : {}),
    metadata: target.metadata,
    frozenAt: target.frozenAt,
  };
}

function consumeReviewEvent(event: AgentLoopEvent, current: string | undefined): string | undefined {
  if (event.type === 'loop.failed') throw new AgentCodeError(event.error);
  if (event.type === 'loop.completed') {
    if (event.reason === 'cancelled') throw new ReviewOutputError('Review operation was cancelled.');
    return event.finalText;
  }
  return current;
}

function buildReviewPrompt(target: FrozenReviewTarget): string {
  return `审查以下冻结目标。不要读取或推断冻结范围之外的变化。

类型：${target.kind}
仓库：${target.repoRoot}
Base SHA：${target.baseSha}
Head SHA：${target.headSha}
Diff SHA-256：${target.diffHash}
${target.focus === undefined ? '' : `关注点：${target.focus}\n`}
<frozen-diff>
${target.diff}
</frozen-diff>`;
}

function parseReviewOutput(text: string): { findings: ReviewFinding[]; summary: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(text);
  let value: unknown;
  try {
    value = JSON.parse((fenced?.[1] ?? text).trim());
  } catch {
    throw new ReviewOutputError('Review output is not valid JSON.');
  }
  if (!isRecord(value) || !Array.isArray(value['findings']) || typeof value['summary'] !== 'string') {
    throw new ReviewOutputError('Review output does not match the required result schema.');
  }
  const findings = value['findings'].map((finding, index): ReviewFinding => parseFinding(finding, index));
  return { findings, summary: value['summary'] };
}

function parseFinding(value: unknown, index: number): ReviewFinding {
  if (
    !isRecord(value) ||
    !isSeverity(value['severity']) ||
    typeof value['file'] !== 'string' ||
    value['file'].length === 0 ||
    (value['line'] !== undefined && (!Number.isSafeInteger(value['line']) || (value['line'] as number) < 1)) ||
    typeof value['title'] !== 'string' ||
    value['title'].length === 0 ||
    typeof value['scenario'] !== 'string' ||
    value['scenario'].length === 0 ||
    typeof value['evidence'] !== 'string' ||
    value['evidence'].length === 0
  ) {
    throw new ReviewOutputError(`Review finding ${index + 1} is invalid.`);
  }
  return {
    severity: value['severity'],
    file: value['file'],
    ...(value['line'] !== undefined ? { line: value['line'] as number } : {}),
    title: value['title'],
    scenario: value['scenario'],
    evidence: value['evidence'],
  };
}

function isSeverity(value: unknown): value is ReviewSeverity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
