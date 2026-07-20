import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

import { atomicWritePrivateFile, readSafeFile } from '../../shared/safeFs.js';
import { createPermissionChecker } from '../../tools/permissions/checker.js';
import { compileRules } from '../../tools/permissions/ruleEngine.js';
import type {
  AskPermissionFn,
  PermissionCheckInput,
  PermissionDecision,
  PermissionRule,
  PermissionRuleConfig,
} from '../../tools/permissions/types.js';
import type { AgentMode, EffectivePermissionMode, PermissionMode, PermissionSnapshot } from '../runtime/types.js';

const PERMISSION_FILE_MODE = 0o600;
const MAX_PERMISSION_BYTES = 1024 * 1024;
const PERMISSION_PATH = join('.agentcode', 'permissions.yaml');

export type PermissionScope = 'session' | 'project' | 'global';
type PersistentPermissionScope = Exclude<PermissionScope, 'session'>;

export interface PermissionRuleView {
  id: string;
  scope: PermissionScope;
  rule: string;
  action: 'allow' | 'deny';
  fingerprint: string;
}

export interface PermissionRuleStorage {
  read(scope: PersistentPermissionScope): Promise<string | undefined>;
  write(scope: PersistentPermissionScope, content: string): Promise<void>;
}

export interface PermissionAuditEvent {
  operation: 'permission.mode' | 'permission.remove' | 'permission.session_rule' | 'permission.project_rule';
  generation: number;
  createdAt: number;
  oldSelectedMode: PermissionMode;
  newSelectedMode: PermissionMode;
  oldEffectiveMode: EffectivePermissionMode;
  newEffectiveMode: EffectivePermissionMode;
  activeRunId?: string;
  scope?: PermissionScope;
  ruleId?: string;
}

export interface PermissionManagerOptions {
  selectedMode: PermissionMode;
  agentMode: AgentMode;
  reviewActive?: boolean;
  cwd?: string;
  homeDir?: string;
  storage?: PermissionRuleStorage;
  askPermission?: AskPermissionFn;
  now?: () => number;
  onAudit?: (event: PermissionAuditEvent) => void | Promise<void>;
}

export interface PermissionMutationContext {
  confirmed?: boolean;
  activeRunId?: string;
}

export type PermissionModeChangeResult =
  | { kind: 'confirmation_required'; from: EffectivePermissionMode; to: PermissionMode }
  | { kind: 'applied'; snapshot: PermissionSnapshot };

export interface RemovePermissionRuleOptions {
  expectedGeneration?: number;
  expectedFingerprint?: string;
  activeRunId?: string;
}

export class PermissionTargetChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionTargetChangedError';
  }
}

interface RuleDocument {
  document: Record<string, unknown>;
  rules: PermissionRule[];
}

interface RuleState {
  session: PermissionRule[];
  project: RuleDocument;
  global: RuleDocument;
}

export class PermissionManager {
  private selectedMode: PermissionMode;
  private agentMode: AgentMode;
  private reviewActive: boolean;
  private generation = 0;
  private rules: RuleState;
  private pending: Promise<void> = Promise.resolve();
  private preflightPending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: PermissionManagerOptions,
    private readonly storage: PermissionRuleStorage,
    rules: RuleState,
  ) {
    this.selectedMode = options.selectedMode;
    this.agentMode = options.agentMode;
    this.reviewActive = options.reviewActive ?? false;
    this.rules = rules;
  }

  static async open(options: PermissionManagerOptions): Promise<PermissionManager> {
    const storage = options.storage ?? createFilePermissionStorage(options.cwd ?? process.cwd(), options.homeDir ?? homedir());
    const [project, global] = await Promise.all([storage.read('project'), storage.read('global')]);
    return new PermissionManager(options, storage, {
      session: [],
      project: parseRuleDocument(project, 'project'),
      global: parseRuleDocument(global, 'global'),
    });
  }

  snapshot(): PermissionSnapshot {
    return Object.freeze({
      selectedMode: this.selectedMode,
      effectiveMode: this.effectiveMode(),
      generation: this.generation,
      counts: Object.freeze({
        session: this.rules.session.length,
        project: this.rules.project.rules.length,
        global: this.rules.global.rules.length,
      }),
    });
  }

  requiresModeConfirmation(mode: PermissionMode): boolean {
    return mode !== this.selectedMode && permissionRank(mode) > permissionRank(this.effectiveMode());
  }

  setSelectedMode(mode: PermissionMode, context: PermissionMutationContext = {}): Promise<PermissionModeChangeResult> {
    return this.serialize(async () => {
      if (mode === this.selectedMode) return { kind: 'applied', snapshot: this.snapshot() };
      const currentEffective = this.effectiveMode();
      if (this.requiresModeConfirmation(mode) && context.confirmed !== true) {
        return { kind: 'confirmation_required', from: currentEffective, to: mode };
      }

      const before = this.snapshot();
      this.selectedMode = mode;
      this.generation += 1;
      const after = this.snapshot();
      await this.emitAudit({
        operation: 'permission.mode',
        generation: this.generation,
        createdAt: (this.options.now ?? Date.now)(),
        oldSelectedMode: before.selectedMode,
        newSelectedMode: after.selectedMode,
        oldEffectiveMode: before.effectiveMode,
        newEffectiveMode: after.effectiveMode,
        ...(context.activeRunId !== undefined ? { activeRunId: context.activeRunId } : {}),
      });
      return { kind: 'applied', snapshot: after };
    });
  }

  setModeCap(cap: { agentMode: AgentMode; reviewActive: boolean }): Promise<PermissionSnapshot> {
    return this.serialize(async () => {
      if (cap.agentMode === this.agentMode && cap.reviewActive === this.reviewActive) return this.snapshot();
      this.agentMode = cap.agentMode;
      this.reviewActive = cap.reviewActive;
      this.generation += 1;
      return this.snapshot();
    });
  }

  async getRuleViews(scope?: PermissionScope): Promise<readonly PermissionRuleView[]> {
    const scopes: readonly PermissionScope[] = scope === undefined ? ['session', 'project', 'global'] : [scope];
    return scopes.flatMap((currentScope) => createRuleViews(currentScope, this.rawRules(currentScope)));
  }

  removeRule(
    scope: PermissionScope,
    ruleId: string,
    options: RemovePermissionRuleOptions = {},
  ): Promise<PermissionRuleView> {
    return this.serialize(async () => {
      this.assertExpectedGeneration(options.expectedGeneration);
      const views = createRuleViews(scope, this.rawRules(scope));
      const index = views.findIndex((view) => view.id === ruleId);
      const view = views[index];
      if (view === undefined) throw new PermissionTargetChangedError(`Permission rule no longer exists: ${ruleId}`);
      if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== view.fingerprint) {
        throw new PermissionTargetChangedError(`Permission rule changed before confirmation: ${ruleId}`);
      }

      const before = this.snapshot();
      const nextRules = this.rawRules(scope).filter((_, ruleIndex) => ruleIndex !== index);
      if (scope === 'session') {
        this.rules = { ...this.rules, session: nextRules };
      } else {
        const current = this.rules[scope];
        const nextDocument: RuleDocument = { document: current.document, rules: nextRules };
        await this.storage.write(scope, serializeRuleDocument(nextDocument));
        this.rules = { ...this.rules, [scope]: nextDocument };
      }
      this.generation += 1;
      const after = this.snapshot();
      await this.emitAudit({
        operation: 'permission.remove',
        generation: this.generation,
        createdAt: (this.options.now ?? Date.now)(),
        oldSelectedMode: before.selectedMode,
        newSelectedMode: after.selectedMode,
        oldEffectiveMode: before.effectiveMode,
        newEffectiveMode: after.effectiveMode,
        scope,
        ruleId,
        ...(options.activeRunId !== undefined ? { activeRunId: options.activeRunId } : {}),
      });
      return view;
    });
  }

  addSessionRule(rule: PermissionRule, context: { activeRunId?: string } = {}): Promise<PermissionRuleView> {
    return this.serialize(async () => {
      const before = this.snapshot();
      this.rules = { ...this.rules, session: [rule, ...this.rules.session] };
      this.generation += 1;
      const view = createRuleViews('session', this.rules.session)[0]!;
      const after = this.snapshot();
      await this.emitAudit({
        operation: 'permission.session_rule',
        generation: this.generation,
        createdAt: (this.options.now ?? Date.now)(),
        oldSelectedMode: before.selectedMode,
        newSelectedMode: after.selectedMode,
        oldEffectiveMode: before.effectiveMode,
        newEffectiveMode: after.effectiveMode,
        scope: 'session',
        ruleId: view.id,
        ...(context.activeRunId !== undefined ? { activeRunId: context.activeRunId } : {}),
      });
      return view;
    });
  }

  addProjectRule(rule: PermissionRule, context: { activeRunId?: string } = {}): Promise<PermissionRuleView> {
    return this.serialize(async () => {
      const before = this.snapshot();
      const current = this.rules.project;
      const nextDocument: RuleDocument = { document: current.document, rules: [rule, ...current.rules] };
      await this.storage.write('project', serializeRuleDocument(nextDocument));
      this.rules = { ...this.rules, project: nextDocument };
      this.generation += 1;
      const view = createRuleViews('project', nextDocument.rules)[0]!;
      const after = this.snapshot();
      await this.emitAudit({
        operation: 'permission.project_rule',
        generation: this.generation,
        createdAt: (this.options.now ?? Date.now)(),
        oldSelectedMode: before.selectedMode,
        newSelectedMode: after.selectedMode,
        oldEffectiveMode: before.effectiveMode,
        newEffectiveMode: after.effectiveMode,
        scope: 'project',
        ruleId: view.id,
        ...(context.activeRunId !== undefined ? { activeRunId: context.activeRunId } : {}),
      });
      return view;
    });
  }

  preflight(
    input: PermissionCheckInput,
    context: { activeRunId?: string } = {},
  ): Promise<{ generation: number; decision: PermissionDecision }> {
    const result = this.preflightPending.then(() => this.performPreflight(input, context));
    this.preflightPending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async performPreflight(
    input: PermissionCheckInput,
    context: { activeRunId?: string },
  ): Promise<{ generation: number; decision: PermissionDecision }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = this.generation;
      const effectiveMode = this.effectiveMode();
      const checker = createPermissionChecker({
        mode: effectiveMode === 'readonly' ? 'plan' : effectiveMode,
        ruleConfig: this.compiledRules(),
        cwd: this.options.cwd ?? process.cwd(),
        ...(this.options.askPermission !== undefined ? { askFn: this.options.askPermission } : {}),
        onRuleGranted: async (scope, rule) => {
          if (scope === 'session') await this.addSessionRule(rule, context);
          else await this.addProjectRule(rule, context);
        },
      });
      const decision = await checker.check(input);
      if (!decision.allowed || this.generation === generation) {
        return { generation: this.generation, decision };
      }
    }
    return {
      generation: this.generation,
      decision: {
        allowed: false,
        source: 'mode_default',
        error: {
          code: 'permission_denied',
          message: 'Permission rules changed repeatedly during tool preflight; retry the operation.',
          retryable: true,
        },
      },
    };
  }

  private effectiveMode(): EffectivePermissionMode {
    return this.agentMode === 'plan' || this.reviewActive ? 'readonly' : this.selectedMode;
  }

  private rawRules(scope: PermissionScope): readonly PermissionRule[] {
    return scope === 'session' ? this.rules.session : this.rules[scope].rules;
  }

  private compiledRules(): PermissionRuleConfig {
    return {
      session: compileRules(this.rules.session),
      project: compileRules(this.rules.project.rules),
      global: compileRules(this.rules.global.rules),
    };
  }

  private assertExpectedGeneration(expected: number | undefined): void {
    if (expected !== undefined && expected !== this.generation) {
      throw new PermissionTargetChangedError(
        `Permission generation changed before confirmation: expected ${expected}, current ${this.generation}`,
      );
    }
  }

  private async emitAudit(event: PermissionAuditEvent): Promise<void> {
    try {
      await this.options.onAudit?.(event);
    } catch (error) {
      console.warn('[PermissionManager] Failed to publish permission audit event', error);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function createFilePermissionStorage(cwd: string, homeDir: string): PermissionRuleStorage {
  const roots: Record<PersistentPermissionScope, string> = {
    project: resolve(cwd),
    global: resolve(homeDir),
  };
  return {
    read: async (scope) => {
      const root = roots[scope];
      const filePath = join(root, PERMISSION_PATH);
      const result = await readSafeFile(root, filePath, MAX_PERMISSION_BYTES);
      if (result === undefined) return undefined;
      if (result.truncated) throw new Error(`Permission file exceeds ${MAX_PERMISSION_BYTES} bytes: ${filePath}`);
      return result.buffer.toString('utf8');
    },
    write: (scope, content) => {
      const root = roots[scope];
      return atomicWritePrivateFile(root, join(root, PERMISSION_PATH), content, PERMISSION_FILE_MODE);
    },
  };
}

function parseRuleDocument(content: string | undefined, scope: PersistentPermissionScope): RuleDocument {
  if (content === undefined || content.trim().length === 0) return { document: {}, rules: [] };
  let value: unknown;
  try {
    value = parse(content);
  } catch {
    throw new Error(`Invalid ${scope} permission YAML.`);
  }
  if (!isRecord(value)) throw new Error(`Invalid ${scope} permission document.`);
  const rawRules = value['rules'];
  if (rawRules === undefined) return { document: value, rules: [] };
  if (!Array.isArray(rawRules)) throw new Error(`Invalid ${scope} permission rules.`);
  const rules = rawRules.map((rule): PermissionRule => {
    if (
      !isRecord(rule) ||
      typeof rule['rule'] !== 'string' ||
      (rule['action'] !== 'allow' && rule['action'] !== 'deny')
    ) {
      throw new Error(`Invalid ${scope} permission rule.`);
    }
    return { rule: rule['rule'], action: rule['action'] };
  });
  return { document: value, rules };
}

function serializeRuleDocument(ruleDocument: RuleDocument): string {
  return stringify({ ...ruleDocument.document, rules: ruleDocument.rules });
}

function createRuleViews(scope: PermissionScope, rules: readonly PermissionRule[]): PermissionRuleView[] {
  const occurrences = new Map<string, number>();
  return rules.map((rule) => {
    const fingerprint = createHash('sha256')
      .update(`${scope}\0${rule.rule}\0${rule.action}`)
      .digest('hex');
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    return {
      id: `${scope}-${fingerprint.slice(0, 12)}-${occurrence}`,
      scope,
      rule: rule.rule,
      action: rule.action,
      fingerprint,
    };
  });
}

function permissionRank(mode: EffectivePermissionMode): number {
  switch (mode) {
    case 'readonly':
      return 0;
    case 'strict':
      return 1;
    case 'normal':
      return 2;
    case 'auto':
      return 3;
    case 'yolo':
      return 4;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
