import { stat } from 'node:fs/promises';

import { searchCodeInputSchema } from '../schemas.js';
import type { ToolDefinition, ToolExecutionContext, ToolExecutionError, ToolExecutionResult, ToolValidationResult } from '../types.js';
import { redactToolValue } from '../redaction.js';
import { createGlobMatcher, type GlobMatcher, isPositiveInteger, truncateUtf8, visitWorkspaceFiles } from './file-discovery.js';
import { readTextFile } from './text-file.js';
import { invalidArguments, isRecord } from './validation.js';

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS_LIMIT = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REGEX_PATTERN_LENGTH = 256;
const MAX_REGEX_LINE_BYTES = 4096;
const PREVIEW_MAX_BYTES = 160;
const BOUNDED_QUANTIFIER_PATTERN = /^\{\d*,?\d*\}$/;

interface SearchCodeInput {
  query: string;
  regex?: boolean;
  include?: string;
  maxResults?: number;
}

interface SearchCodeMatch {
  path: string;
  line: number;
  preview: string;
}

interface SearchCodeOutput {
  matches: SearchCodeMatch[];
  truncated: boolean;
}

interface SearchPredicate {
  regex: boolean;
  findMatchIndex(line: string): number;
}

export function createSearchCodeTool(): ToolDefinition<SearchCodeInput, SearchCodeOutput> {
  return {
    name: 'search_code',
    description: 'Search workspace text files by literal text or regular expression.',
    inputSchema: searchCodeInputSchema,
    risk: 'read',
    validate: validateSearchCodeInput,
    execute: executeSearchCode
  };
}

function validateSearchCodeInput(input: unknown): ToolValidationResult<SearchCodeInput> {
  if (!isRecord(input)) {
    return invalidArguments('search_code arguments must be an object.');
  }

  if (typeof input.query !== 'string' || input.query.length === 0) {
    return invalidArguments('search_code.query must be a non-empty string.');
  }

  if (input.regex !== undefined && typeof input.regex !== 'boolean') {
    return invalidArguments('search_code.regex must be a boolean when provided.');
  }

  if (input.include !== undefined && (typeof input.include !== 'string' || input.include.trim().length === 0)) {
    return invalidArguments('search_code.include must be a non-empty string when provided.');
  }

  if (input.maxResults !== undefined && !isPositiveInteger(input.maxResults)) {
    return invalidArguments('search_code.maxResults must be a positive integer when provided.');
  }

  return {
    ok: true,
    value: {
      query: input.query,
      ...(input.regex !== undefined ? { regex: input.regex } : {}),
      ...(input.include !== undefined ? { include: input.include } : {}),
      ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {})
    }
  };
}

async function executeSearchCode(input: SearchCodeInput, context: ToolExecutionContext): Promise<ToolExecutionResult<SearchCodeOutput>> {
  const predicateResult = createSearchPredicate(input);
  if (!predicateResult.ok) {
    return createSearchCodeError(predicateResult.error);
  }

  let includeMatcher: GlobMatcher | undefined;
  if (input.include !== undefined) {
    const matcherResult = createGlobMatcher(input.include);
    if (!matcherResult.ok) {
      return createSearchCodeError({
        code: 'invalid_arguments',
        message: matcherResult.message,
        retryable: true
      });
    }

    includeMatcher = matcherResult.matcher;
  }

  const maxResults = getEffectiveMaxResults(input.maxResults);
  const matches: SearchCodeMatch[] = [];
  let truncated = false;
  const visitResult = await visitWorkspaceFiles(context.cwd, async (file) => {
    if (context.signal?.aborted) {
      return false;
    }

    if (includeMatcher !== undefined && !includeMatcher.matches(file.relativePath)) {
      return true;
    }

    const searchableStatus = await getSearchableFileStatus(file.absolutePath);
    if (searchableStatus !== 'searchable' || context.signal?.aborted) {
      truncated = truncated || searchableStatus === 'too_large';
      return !context.signal?.aborted;
    }

    const fileResult = await readTextFile(file.absolutePath);
    if (!fileResult.ok || context.signal?.aborted) {
      return !context.signal?.aborted;
    }

    const remainingResults = maxResults + 1 - matches.length;
    const lineMatchResult = findLineMatches(file.relativePath, fileResult.file.content, predicateResult.predicate, context, remainingResults);
    matches.push(...lineMatchResult.matches);
    truncated = truncated || lineMatchResult.truncated;
    return !lineMatchResult.limitReached;
  }, context.signal);
  if (!visitResult.ok) {
    return createSearchCodeError(visitResult.error);
  }

  return {
    ok: true,
    toolName: 'search_code',
    data: {
      matches: matches.slice(0, maxResults),
      truncated
    },
    meta: {
      durationMs: 0,
      timedOut: false,
      truncated
    }
  };
}

function createSearchPredicate(input: SearchCodeInput):
  | {
      ok: true;
      predicate: SearchPredicate;
    }
  | {
      ok: false;
      error: ToolExecutionError;
    } {
  if (input.regex !== true) {
    return {
      ok: true,
      predicate: {
        regex: false,
        findMatchIndex: (line: string) => line.indexOf(input.query)
      }
    };
  }

  const safetyError = validateRegexSafety(input.query);
  if (safetyError !== undefined) {
    return {
      ok: false,
      error: {
        code: 'invalid_arguments',
        message: safetyError,
        retryable: true
      }
    };
  }

  try {
    const regex = new RegExp(input.query);
    return {
      ok: true,
      predicate: {
        regex: true,
        findMatchIndex: (line: string) => {
          regex.lastIndex = 0;
          return regex.exec(line)?.index ?? -1;
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'invalid_arguments',
        message: error instanceof Error ? `Invalid regular expression: ${error.message}` : 'Invalid regular expression.',
        retryable: true
      }
    };
  }
}

function validateRegexSafety(pattern: string): string | undefined {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `search_code.query must be at most ${MAX_REGEX_PATTERN_LENGTH} characters when regex is true.`;
  }

  if (hasBackreference(pattern)) {
    return 'search_code.query must not use regular expression backreferences.';
  }

  if (hasRepeatedRiskyGroup(pattern)) {
    return 'search_code.query must not repeat regular expression groups that contain quantifiers or alternation.';
  }

  if (hasAmbiguousOptionalQuantifierChain(pattern)) {
    return 'search_code.query must not use long ambiguous optional quantifier chains.';
  }

  return undefined;
}

function hasBackreference(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== '\\') {
      continue;
    }

    const slashCount = countPrecedingBackslashes(pattern, index) + 1;
    if (slashCount % 2 === 0) {
      continue;
    }

    const nextChar = pattern[index + 1];
    if (nextChar !== undefined && /[1-9]/.test(nextChar)) {
      return true;
    }

    if (nextChar === 'k' && pattern[index + 2] === '<') {
      return true;
    }
  }

  return false;
}

function countPrecedingBackslashes(pattern: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && pattern[cursor] === '\\'; cursor -= 1) {
    count += 1;
  }
  return count;
}

function hasAmbiguousOptionalQuantifierChain(pattern: string): boolean {
  let optionalAtoms = 0;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === '[') {
      inCharacterClass = true;
      continue;
    }

    if (char === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }

    if (inCharacterClass || char !== '?') {
      continue;
    }

    if (isGroupPrefixQuestion(pattern, index) || isLazyQuantifierQuestion(pattern, index)) {
      continue;
    }

    optionalAtoms += 1;
    if (optionalAtoms >= 4) {
      return true;
    }
  }

  return false;
}

function isGroupPrefixQuestion(pattern: string, questionIndex: number): boolean {
  return pattern[questionIndex - 1] === '(';
}

function isLazyQuantifierQuestion(pattern: string, questionIndex: number): boolean {
  const previousChar = pattern[questionIndex - 1];
  if (previousChar === '*' || previousChar === '+' || previousChar === '?') {
    return true;
  }

  if (previousChar !== '}') {
    return false;
  }

  const openingBraceIndex = pattern.lastIndexOf('{', questionIndex - 1);
  return openingBraceIndex !== -1 && BOUNDED_QUANTIFIER_PATTERN.test(pattern.slice(openingBraceIndex, questionIndex));
}

interface RegexGroupState {
  hasAlternation: boolean;
  hasNestedGroup: boolean;
  hasQuantifier: boolean;
}

function hasRepeatedRiskyGroup(pattern: string): boolean {
  const groups: RegexGroupState[] = [];
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === '[') {
      inCharacterClass = true;
      continue;
    }

    if (char === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }

    if (inCharacterClass) {
      continue;
    }

    if (char === '(') {
      const parent = groups.at(-1);
      if (parent !== undefined) {
        parent.hasNestedGroup = true;
      }

      groups.push({
        hasAlternation: false,
        hasNestedGroup: false,
        hasQuantifier: false
      });
      index = skipOpeningGroupPrefix(pattern, index);
      continue;
    }

    if (char === '|') {
      const group = groups.at(-1);
      if (group !== undefined) {
        group.hasAlternation = true;
      }
      continue;
    }

    if (char === ')') {
      const group = groups.pop();
      if (group === undefined) {
        continue;
      }

      const nextIndex = index + 1;
      const repeated = isRepeatingQuantifierAt(pattern, nextIndex);
      if (repeated && (group.hasAlternation || group.hasNestedGroup || group.hasQuantifier)) {
        return true;
      }

      const parent = groups.at(-1);
      if (parent !== undefined && isQuantifierAt(pattern, nextIndex)) {
        parent.hasQuantifier = true;
      }
      continue;
    }

    if (isQuantifierAt(pattern, index)) {
      const group = groups.at(-1);
      if (group !== undefined) {
        group.hasQuantifier = true;
      }
    }
  }

  return false;
}

function skipOpeningGroupPrefix(pattern: string, openParenIndex: number): number {
  if (pattern[openParenIndex + 1] !== '?') {
    return openParenIndex;
  }

  const prefixKind = pattern[openParenIndex + 2];
  if (prefixKind === ':' || prefixKind === '=' || prefixKind === '!') {
    return openParenIndex + 2;
  }

  if (prefixKind === '<') {
    const lookbehindKind = pattern[openParenIndex + 3];
    if (lookbehindKind === '=' || lookbehindKind === '!') {
      return openParenIndex + 3;
    }

    const nameEndIndex = pattern.indexOf('>', openParenIndex + 3);
    if (nameEndIndex !== -1) {
      return nameEndIndex;
    }
  }

  return openParenIndex;
}

function isRepeatingQuantifierAt(pattern: string, index: number): boolean {
  return pattern[index] === '+' || pattern[index] === '*' || pattern[index] === '{';
}

function isQuantifierAt(pattern: string, index: number): boolean {
  return isRepeatingQuantifierAt(pattern, index) || pattern[index] === '?';
}

function isRegexSearchableLine(line: string): boolean {
  return Buffer.byteLength(line, 'utf8') <= MAX_REGEX_LINE_BYTES;
}

async function getSearchableFileStatus(absolutePath: string): Promise<'searchable' | 'too_large' | 'unavailable'> {
  try {
    const stats = await stat(absolutePath);
    return stats.size <= MAX_FILE_BYTES ? 'searchable' : 'too_large';
  } catch {
    return 'unavailable';
  }
}

function findLineMatches(
  path: string,
  content: string,
  predicate: SearchPredicate,
  context: ToolExecutionContext,
  maxMatches: number
): { matches: SearchCodeMatch[]; truncated: boolean; limitReached: boolean } {
  const matches: SearchCodeMatch[] = [];
  const lines = content.split(/\r?\n/);

  let truncated = false;

  for (const [index, line] of lines.entries()) {
    if (context.signal?.aborted) {
      return {
        matches,
        truncated: true,
        limitReached: true
      };
    }

    if (predicate.regex && !isRegexSearchableLine(line)) {
      truncated = true;
      continue;
    }

    const matchIndex = predicate.findMatchIndex(line);
    if (matchIndex === -1) {
      continue;
    }

    if (matches.length >= maxMatches) {
      return {
        matches,
        truncated: true,
        limitReached: true
      };
    }

    matches.push({
      path,
      line: index + 1,
      preview: createPreview(line, matchIndex, context)
    });

    if (matches.length >= maxMatches) {
      return {
        matches,
        truncated: true,
        limitReached: true
      };
    }
  }

  return {
    matches,
    truncated,
    limitReached: false
  };
}

function createPreview(line: string, matchIndex: number, context: ToolExecutionContext): string {
  const redactedLine = redactToolValue(line, context.secrets);
  const safeLine = typeof redactedLine === 'string' ? redactedLine : line;
  const redactedPrefix = redactToolValue(line.slice(0, matchIndex), context.secrets);
  const safePrefix = typeof redactedPrefix === 'string' ? redactedPrefix : line.slice(0, matchIndex);
  const leadingTrimmedCharacters = safeLine.length - safeLine.trimStart().length;
  const trimmedLine = safeLine.trim();
  const trimmedMatchIndex = Math.max(0, safePrefix.length - leadingTrimmedCharacters);
  const previewStart = getPreviewStart(trimmedLine, trimmedMatchIndex);
  return truncateUtf8(trimmedLine.slice(previewStart), PREVIEW_MAX_BYTES).content;
}

function getPreviewStart(line: string, matchIndex: number): number {
  if (Buffer.byteLength(line.slice(0, matchIndex), 'utf8') <= PREVIEW_MAX_BYTES / 2) {
    return 0;
  }

  let start = matchIndex;
  let bytes = 0;
  while (start > 0 && bytes < PREVIEW_MAX_BYTES / 2) {
    const previousChar = line[start - 1];
    if (previousChar === undefined) {
      break;
    }

    bytes += Buffer.byteLength(previousChar, 'utf8');
    start -= 1;
  }

  return start;
}

function getEffectiveMaxResults(inputMaxResults: number | undefined): number {
  return Math.min(inputMaxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT);
}

function createSearchCodeError(error: ToolExecutionError): ToolExecutionResult<SearchCodeOutput> {
  return {
    ok: false,
    toolName: 'search_code',
    error,
    meta: {
      durationMs: 0,
      timedOut: false
    }
  };
}
