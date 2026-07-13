import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import type { PermissionRule, PermissionRuleConfig } from './types.js';
import { compileRules } from './ruleEngine.js';

/** 项目级权限配置文件相对路径 */
const PROJECT_PERMISSIONS_PATH = '.agentcode/permissions.yaml';

/** 全局级权限配置文件相对路径（在 home 下） */
const GLOBAL_PERMISSIONS_PATH = '.agentcode/permissions.yaml';

interface RawPermissionsYaml {
  rules?: unknown[];
}

/**
 * 从 YAML 文件加载规则数组。
 * 文件不存在返回空数组，格式错误 warn 并返回空数组。
 */
function loadRulesFromFile(filePath: string): PermissionRule[] {
  if (!existsSync(filePath)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    console.warn(`[permission] 无法读取规则文件: ${filePath}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    console.warn(`[permission] YAML 格式错误: ${filePath}`);
    return [];
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return [];
  }

  const yaml = parsed as RawPermissionsYaml;
  if (!Array.isArray(yaml.rules)) {
    return [];
  }

  const rules: PermissionRule[] = [];
  for (const item of yaml.rules) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'rule' in item &&
      'action' in item &&
      typeof (item as Record<string, unknown>).rule === 'string' &&
      ((item as Record<string, unknown>).action === 'allow' ||
        (item as Record<string, unknown>).action === 'deny')
    ) {
      rules.push({
        rule: (item as Record<string, unknown>).rule as string,
        action: (item as Record<string, unknown>).action as 'allow' | 'deny',
      });
    }
  }

  return rules;
}

/**
 * 加载三层权限规则配置。
 * session 层始终为空（运行时由 sessionAllowlist 管理）。
 */
export function loadPermissionRules(cwd: string, homeDir: string): PermissionRuleConfig {
  const projectPath = join(cwd, PROJECT_PERMISSIONS_PATH);
  const globalPath = join(homeDir, GLOBAL_PERMISSIONS_PATH);

  const projectRules = loadRulesFromFile(projectPath);
  const globalRules = loadRulesFromFile(globalPath);

  return {
    session: [],
    project: compileRules(projectRules),
    global: compileRules(globalRules),
  };
}

/**
 * 向项目级 permissions.yaml 追加一条 allow 规则。
 * 文件不存在时自动创建。
 */
export function appendProjectRule(cwd: string, ruleStr: string): void {
  const filePath = join(cwd, PROJECT_PERMISSIONS_PATH);
  const dirPath = join(cwd, '.agentcode');

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  let existing: PermissionRule[] = [];
  if (existsSync(filePath)) {
    existing = loadRulesFromFile(filePath);
  }

  existing.push({ rule: ruleStr, action: 'allow' });

  const yamlContent = stringify({ rules: existing });
  writeFileSync(filePath, yamlContent, 'utf-8');
}
