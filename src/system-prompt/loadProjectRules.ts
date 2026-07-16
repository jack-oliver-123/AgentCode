import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { readSafeFile, SafePathError } from '../shared/safeFs.js';

const CONFIG_DIRECTORY = '.agentcode';
const RULES_FILE = 'AGENTCODE.md';
const MAX_FILE_BYTES = 25 * 1024;
const MAX_INCLUDE_DEPTH = 4;
const INCLUDE_PATTERN = /^\s*@include\s+(.+?)\s*$/;

type IncludeWarningHandler = (error: Error) => void;

interface RuleSource {
  filePath: string;
  allowedRoot: string;
}

/** 按项目具体层、项目根层、全局层的顺序加载 AGENTCODE.md。 */
export async function loadProjectRules(cwd: string, homeDir: string): Promise<string> {
  const projectRoot = resolve(cwd);
  const globalRoot = resolve(homeDir, CONFIG_DIRECTORY);
  const sources: RuleSource[] = [
    { filePath: join(projectRoot, CONFIG_DIRECTORY, RULES_FILE), allowedRoot: projectRoot },
    { filePath: join(projectRoot, RULES_FILE), allowedRoot: projectRoot },
    { filePath: join(globalRoot, RULES_FILE), allowedRoot: globalRoot },
  ];

  const contents = await Promise.all(sources.map(loadRuleSource));
  return contents.filter((content) => content.length > 0).join('\n\n');
}

/**
 * 展开 content 中的整行 @include 指令。
 * 未提供 onWarning 时安全边界错误向上传播；生产加载器会逐条记录并继续。
 */
export async function resolveIncludes(
  content: string,
  baseDir: string,
  allowedRoot: string,
  visited: Set<string> = new Set<string>(),
  depth = 0,
  onWarning?: IncludeWarningHandler,
): Promise<string> {
  const lines = content.split(/\r?\n/);
  const expanded: string[] = [];

  for (const line of lines) {
    const match = INCLUDE_PATTERN.exec(line);
    if (match === null) {
      expanded.push(line);
      continue;
    }

    const includeTarget = normalizeIncludeTarget(match[1]!);
    if (includeTarget.length === 0 || depth >= MAX_INCLUDE_DEPTH) {
      continue;
    }

    try {
      const targetPath = resolve(baseDir, includeTarget);
      assertWithinRoot(targetPath, resolve(allowedRoot));

      const [canonicalTarget, canonicalRoot] = await Promise.all([
        realpathOrUndefined(targetPath),
        realpathOrUndefined(resolve(allowedRoot)),
      ]);
      if (canonicalTarget === undefined) {
        continue;
      }
      const effectiveRoot = canonicalRoot ?? resolve(allowedRoot);
      assertWithinRoot(canonicalTarget, effectiveRoot);

      const visitKey = comparablePath(canonicalTarget);
      if (visited.has(visitKey)) {
        continue;
      }
      visited.add(visitKey);

      const includedContent = await readInstructionFile(canonicalTarget, effectiveRoot);
      if (includedContent === undefined) {
        continue;
      }
      expanded.push(
        await resolveIncludes(
          includedContent,
          dirname(canonicalTarget),
          effectiveRoot,
          visited,
          depth + 1,
          onWarning,
        ),
      );
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (onWarning === undefined) {
        throw normalized;
      }
      onWarning(normalized);
    }
  }

  return expanded.join('\n');
}

async function loadRuleSource(source: RuleSource): Promise<string> {
  try {
    const [canonicalFile, canonicalRoot] = await Promise.all([
      realpathOrUndefined(source.filePath),
      realpathOrUndefined(source.allowedRoot),
    ]);
    if (canonicalFile === undefined) {
      return '';
    }

    const effectiveRoot = canonicalRoot ?? resolve(source.allowedRoot);
    assertWithinRoot(canonicalFile, effectiveRoot);
    const content = await readInstructionFile(canonicalFile, effectiveRoot);
    if (content === undefined) {
      return '';
    }

    const visited = new Set<string>([comparablePath(canonicalFile)]);
    return (
      await resolveIncludes(content, dirname(canonicalFile), effectiveRoot, visited, 0, (error) => {
        console.warn(`[project-rules] 跳过不安全的 @include: ${error.message}`, error);
      })
    ).trim();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    console.warn(`[project-rules] 跳过无法安全加载的规则文件: ${source.filePath}`, normalized);
    return '';
  }
}

async function readInstructionFile(filePath: string, allowedRoot: string): Promise<string | undefined> {
  try {
    const result = await readSafeFile(allowedRoot, filePath, MAX_FILE_BYTES);
    if (result === undefined) return undefined;
    const buffer = result.buffer;
    if (buffer.length === 0) {
      return '';
    }
    if (!result.truncated) {
      return buffer.toString('utf8').trim();
    }
    return `${decodeCompleteUtf8(buffer).trim()}\n...(truncated)`;
  } catch (error) {
    if (error instanceof SafePathError) throw error;
    return undefined;
  }
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function assertWithinRoot(targetPath: string, allowedRoot: string): void {
  const pathFromRoot = relative(allowedRoot, targetPath);
  if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw new Error(`Included path "${targetPath}" is outside allowed root "${allowedRoot}".`);
}

function normalizeIncludeTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (
    (trimmed.startsWith('<') && trimmed.endsWith('>')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function decodeCompleteUtf8(buffer: Buffer): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = buffer.length; end >= Math.max(0, buffer.length - 4); end--) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // 最多回退一个 UTF-8 编码单元。
    }
  }
  return '';
}
