import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

import { atomicWritePrivateFile, ensurePrivateDirectory, readSafeFile } from '../../shared/safeFs.js';
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
const PERMISSION_LOCK_TIMEOUT_MS = 5_000;
const PERMISSION_LOCK_RETRY_MS = 25;

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
  compareAndSwap?(
    scope: PersistentPermissionScope,
    expected: string | undefined,
    content: string,
  ): Promise<boolean>;
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
  source: string | undefined;
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
  private activeSessionId: string | undefined;
  private readonly sessionRules = new Map<string, PermissionRule[]>();
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

  activateSession(sessionId: string): Promise<PermissionSnapshot> {
    const normalized = sessionId.trim();
    if (normalized.length === 0) return Promise.reject(new Error('Session ID must not be empty.'));
    return this.serialize(async () => {
      if (this.activeSessionId === normalized) return this.snapshot();
      if (this.activeSessionId !== undefined) {
        this.sessionRules.set(this.activeSessionId, [...this.rules.session]);
      }
      const hadActiveSession = this.activeSessionId !== undefined;
      this.activeSessionId = normalized;
      const nextRules = this.sessionRules.get(normalized) ?? (hadActiveSession ? [] : this.rules.session);
      this.rules = { ...this.rules, session: [...nextRules] };
      this.sessionRules.set(normalized, [...nextRules]);
      if (hadActiveSession) this.generation += 1;
      return this.snapshot();
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
        this.setSessionRules(nextRules);
      } else {
        const current = this.rules[scope];
        const nextDocument = await this.persistRuleDocument(scope, current, nextRules);
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
      this.setSessionRules([rule, ...this.rules.session]);
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
      const nextDocument = await this.persistRuleDocument('project', current, [rule, ...current.rules]);
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

  private setSessionRules(rules: readonly PermissionRule[]): void {
    const next = rules.map((rule) => ({ ...rule }));
    this.rules = { ...this.rules, session: next };
    if (this.activeSessionId !== undefined) this.sessionRules.set(this.activeSessionId, [...next]);
  }

  private async persistRuleDocument(
    scope: PersistentPermissionScope,
    current: RuleDocument,
    rules: readonly PermissionRule[],
  ): Promise<RuleDocument> {
    const candidate: RuleDocument = {
      document: current.document,
      rules: rules.map((rule) => ({ ...rule })),
      source: undefined,
    };
    const serialized = serializeRuleDocument(candidate);
    const committed = this.storage.compareAndSwap !== undefined
      ? await this.storage.compareAndSwap(scope, current.source, serialized)
      : await this.compareAndSwapFallback(scope, current.source, serialized);
    if (!committed) {
      const disk = await this.storage.read(scope);
      this.rules = { ...this.rules, [scope]: parseRuleDocument(disk, scope) };
      this.generation += 1;
      throw new PermissionTargetChangedError(`Permission file changed on disk before ${scope} rules were persisted.`);
    }
    return { ...candidate, source: serialized };
  }

  private async compareAndSwapFallback(
    scope: PersistentPermissionScope,
    expected: string | undefined,
    content: string,
  ): Promise<boolean> {
    if ((await this.storage.read(scope)) !== expected) return false;
    await this.storage.write(scope, content);
    return true;
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
    compareAndSwap: (scope, expected, content) => {
      const root = roots[scope];
      return compareAndSwapPermissionFile(root, join(root, PERMISSION_PATH), expected, content);
    },
  };
}

function parseRuleDocument(content: string | undefined, scope: PersistentPermissionScope): RuleDocument {
  if (content === undefined || content.trim().length === 0) return { document: {}, rules: [], source: content };
  let value: unknown;
  try {
    value = parse(content);
  } catch (error) {
    warnInvalidPermission(scope, 'YAML', error);
    return { document: {}, rules: [], source: content };
  }
  if (!isRecord(value)) {
    warnInvalidPermission(scope, 'document');
    return { document: {}, rules: [], source: content };
  }
  const rawRules = value['rules'];
  if (rawRules === undefined) return { document: value, rules: [], source: content };
  if (!Array.isArray(rawRules)) {
    warnInvalidPermission(scope, 'rules');
    return { document: value, rules: [], source: content };
  }
  const rules: PermissionRule[] = [];
  rawRules.forEach((rule, index) => {
    if (
      !isRecord(rule) ||
      typeof rule['rule'] !== 'string' ||
      (rule['action'] !== 'allow' && rule['action'] !== 'deny')
    ) {
      warnInvalidPermission(scope, `rule ${index + 1}`);
      return;
    }
    const candidate: PermissionRule = { rule: rule['rule'], action: rule['action'] };
    try {
      compileRules([candidate]);
      rules.push(candidate);
    } catch (error) {
      warnInvalidPermission(scope, `rule ${index + 1}`, error);
    }
  });
  return { document: value, rules, source: content };
}

function serializeRuleDocument(ruleDocument: RuleDocument): string {
  return stringify({ ...ruleDocument.document, rules: ruleDocument.rules });
}

async function compareAndSwapPermissionFile(
  root: string,
  filePath: string,
  expected: string | undefined,
  content: string,
): Promise<boolean> {
  const directory = await ensurePrivateDirectory(root, dirname(filePath), 0o700);
  const lockPath = join(directory, `.${basename(filePath)}.lock`);
  const lock = await acquirePermissionLock(lockPath);
  try {
    const current = await readSafeFile(root, filePath, MAX_PERMISSION_BYTES);
    if (current?.truncated) throw new Error(`Permission file exceeds ${MAX_PERMISSION_BYTES} bytes: ${filePath}`);
    const currentContent = current?.buffer.toString('utf8');
    if (currentContent !== expected) return false;
    await atomicWritePrivateFile(root, filePath, content, PERMISSION_FILE_MODE);
    return true;
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath).catch(() => undefined);
  }
}

async function acquirePermissionLock(lockPath: string) {
  const deadline = Date.now() + PERMISSION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        PERMISSION_FILE_MODE,
      );
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      return handle;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for permission file lock: ${lockPath}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, PERMISSION_LOCK_RETRY_MS));
    }
  }
}

function warnInvalidPermission(scope: PersistentPermissionScope, part: string, error?: unknown): void {
  console.warn(
    `[PermissionManager] Ignoring invalid ${scope} permission ${part}.`,
    ...(error === undefined ? [] : [error]),
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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
