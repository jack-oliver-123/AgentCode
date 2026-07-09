import { redactText } from '../config/redact.js';
import type { ToolExecutionResult } from './types.js';

const SENSITIVE_FIELD_NAME_PATTERN =
  /^(?:api\s*key|api[_-]?key|x-api-key|authorization|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|jwt)$/i;
const QUOTED_SECRET_FIELD_PATTERN =
  /(["'](?:api\s*key|api[_-]?key|x-api-key|authorization|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|jwt)["']\s*:\s*["'])(?:\.|[^"'\])*(["'])/gi;
const UNQUOTED_SECRET_FIELD_PATTERN =
  /((?:api\s*key|api[_-]?key|x-api-key|authorization|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|jwt)\s*[:=]\s*)[^\s,;}]+/gi;
const PUBLIC_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [QUOTED_SECRET_FIELD_PATTERN, '$1<redacted>$2'],
  [/(authorization\s*[:=]\s*)[^\r\n]+/gi, '$1<redacted>'],
  [/(bearer\s+)[^\s,;]+/gi, '$1<redacted>'],
  [UNQUOTED_SECRET_FIELD_PATTERN, '$1<redacted>'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>'],
  [/sk-[A-Za-z0-9._-]{8,}/g, 'sk-<redacted>'],
];

export function redactToolResult<T>(
  result: ToolExecutionResult<T>,
  secrets: readonly string[],
): ToolExecutionResult<T> {
  return redactToolValue(result, secrets) as ToolExecutionResult<T>;
}

export function redactToolValue(value: unknown, secrets: readonly string[]): unknown {
  return redactValue(value, secrets);
}

function redactValue(value: unknown, secrets: readonly string[], key?: string): unknown {
  if (isSensitiveFieldName(key)) {
    return '<redacted>';
  }

  if (typeof value === 'string') {
    return redactToolText(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        redactObjectKey(nestedKey, secrets),
        redactValue(nestedValue, secrets, nestedKey),
      ]),
    );
  }

  return value;
}

function redactObjectKey(key: string, secrets: readonly string[]): string {
  return redactToolText(key, secrets);
}

function redactToolText(text: string, secrets: readonly string[]): string {
  const parsedJson = parseJsonLikeText(text);
  if (parsedJson !== undefined) {
    const redactedJson = JSON.stringify(redactValue(parsedJson, secrets));
    const normalizedOriginalJson = JSON.stringify(parsedJson);
    return redactedJson === normalizedOriginalJson ? text : redactedJson;
  }

  const textWithRedactedJson = redactEmbeddedJsonFragments(text, secrets);
  const textWithoutKnownSecrets = redactKnownSecrets(textWithRedactedJson, secrets);
  return PUBLIC_SECRET_PATTERNS.reduce(
    (currentText, [pattern, replacement]) => currentText.replace(pattern, replacement),
    redactText(textWithoutKnownSecrets, []),
  );
}

function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((currentText, secret) => {
    if (secret.length === 0) {
      return currentText;
    }

    return currentText.split(secret).join('<redacted>');
  }, text);
}

function redactEmbeddedJsonFragments(text: string, secrets: readonly string[]): string {
  let redactedText = '';
  let cursor = 0;

  while (cursor < text.length) {
    const fragmentStart = findNextJsonStart(text, cursor);
    if (fragmentStart === -1) {
      redactedText += text.slice(cursor);
      break;
    }

    redactedText += text.slice(cursor, fragmentStart);
    const fragmentEnd = findJsonFragmentEnd(text, fragmentStart);
    if (fragmentEnd === -1) {
      redactedText += text.slice(fragmentStart);
      break;
    }

    const fragment = text.slice(fragmentStart, fragmentEnd + 1);
    const parsedFragment = parseJsonLikeText(fragment);
    if (parsedFragment === undefined) {
      redactedText += text[fragmentStart];
      cursor = fragmentStart + 1;
      continue;
    }

    redactedText += JSON.stringify(redactValue(parsedFragment, secrets));
    cursor = fragmentEnd + 1;
  }

  return redactedText;
}

function findNextJsonStart(text: string, startIndex: number): number {
  const objectIndex = text.indexOf('{', startIndex);
  const arrayIndex = text.indexOf('[', startIndex);

  if (objectIndex === -1) {
    return arrayIndex;
  }

  if (arrayIndex === -1) {
    return objectIndex;
  }

  return Math.min(objectIndex, arrayIndex);
}

function findJsonFragmentEnd(text: string, startIndex: number): number {
  const stack: string[] = [];
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let index = startIndex; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === stringQuote) {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === '{') {
      stack.push('}');
      continue;
    }

    if (char === '[') {
      stack.push(']');
      continue;
    }

    if (char === '}' || char === ']') {
      const expectedClose = stack.pop();
      if (expectedClose !== char) {
        return -1;
      }

      if (stack.length === 0) {
        return index;
      }
    }
  }

  return -1;
}

function parseJsonLikeText(text: string): unknown | undefined {
  const trimmedText = text.trim();
  if (!trimmedText.startsWith('{') && !trimmedText.startsWith('[')) {
    return undefined;
  }

  try {
    return JSON.parse(trimmedText) as unknown;
  } catch {
    return undefined;
  }
}

function isSensitiveFieldName(key: string | undefined): boolean {
  return key !== undefined && SENSITIVE_FIELD_NAME_PATTERN.test(normalizeFieldName(key));
}

function normalizeFieldName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
