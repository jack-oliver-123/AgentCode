import { describe, expect, it } from 'vitest';

import { redactToolResult, redactToolValue } from '../../../src/tools/redaction.js';
import type { ToolExecutionResult } from '../../../src/tools/types.js';

const SENTINEL_SECRET = 'sk-agentcode-e2e-secret-should-not-appear';
const JWT_SECRET = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature';

describe('redactToolValue', () => {
  it('redacts known secrets and public secret patterns in nested values', () => {
    const value = {
      content: `api_key=${SENTINEL_SECRET}`,
      stdout: [`Authorization: Bearer ${SENTINEL_SECRET}`, `jwt: ${JWT_SECRET}`],
      nested: {
        stderr: `token=${SENTINEL_SECRET}`,
      },
    };

    const redacted = redactToolValue(value, [SENTINEL_SECRET]);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(SENTINEL_SECRET);
    expect(serialized).not.toContain(JWT_SECRET);
    expect(serialized).toContain('<redacted>');
  });

  it('redacts JSON-shaped secret fields that are not in the known secret list', () => {
    const accessToken = 'access-token-should-disappear';
    const apiKey = 'json-api-key-should-disappear';
    const value = {
      content: `{"token":"new-token-should-disappear","api_key":"${apiKey}","access_token":"${accessToken}"}`,
      authorization: 'Basic newly-generated-secret',
      client_secret: 'object-client-secret-should-disappear',
    };

    const redacted = redactToolValue(value, []);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('new-token-should-disappear');
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain('newly-generated-secret');
    expect(serialized).not.toContain('object-client-secret-should-disappear');
  });

  it('redacts sensitive field subtrees and escaped JSON keys', () => {
    const value = {
      token: ['array-secret-should-disappear'],
      accessToken: ['camel-access-token-should-disappear'],
      clientSecret: {
        value: 'camel-client-secret-should-disappear',
      },
      authorization: {
        raw: 'Bearer nested-secret-should-disappear',
      },
      content:
        '{"tok\\u0065n":"escaped-token-should-disappear","client_\\u0073ecret":"escaped-client-secret-should-disappear"}',
    };

    const redacted = redactToolValue(value, []);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('array-secret-should-disappear');
    expect(serialized).not.toContain('camel-access-token-should-disappear');
    expect(serialized).not.toContain('camel-client-secret-should-disappear');
    expect(serialized).not.toContain('nested-secret-should-disappear');
    expect(serialized).not.toContain('escaped-token-should-disappear');
    expect(serialized).not.toContain('escaped-client-secret-should-disappear');
  });

  it('redacts secrets from object keys and free text authorization patterns without known secrets', () => {
    const value = {
      [SENTINEL_SECRET]: 'value',
      logs: ['Authorization: Bearer transient-token-should-disappear', 'Bearer other-token-should-disappear'],
    };

    const redacted = redactToolValue(value, []);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(SENTINEL_SECRET);
    expect(serialized).not.toContain('transient-token-should-disappear');
    expect(serialized).not.toContain('other-token-should-disappear');
    expect(serialized).toContain('<redacted>');
  });

  it('redacts sensitive subtrees from embedded JSON fragments in log text', () => {
    const value = {
      logs: [
        'response={"authorization":{"session":"embedded-session-secret"}}',
        'stdout: {"token":{"value":"embedded-token-secret"}} done',
      ],
    };

    const redacted = redactToolValue(value, []);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('embedded-session-secret');
    expect(serialized).not.toContain('embedded-token-secret');
    expect(serialized).toContain('<redacted>');
  });

  it('leaves non-string primitive values unchanged', () => {
    expect(redactToolValue(42, [SENTINEL_SECRET])).toBe(42);
    expect(redactToolValue(false, [SENTINEL_SECRET])).toBe(false);
    expect(redactToolValue(null, [SENTINEL_SECRET])).toBeNull();
  });
});

describe('redactToolResult', () => {
  it('redacts successful tool result data', () => {
    const result: ToolExecutionResult = {
      ok: true,
      toolName: 'read_file',
      data: {
        content: `secret=${SENTINEL_SECRET}`,
      },
      meta: {
        durationMs: 1,
        timedOut: false,
      },
    };

    const redacted = redactToolResult(result, [SENTINEL_SECRET]);

    expect(JSON.stringify(redacted)).not.toContain(SENTINEL_SECRET);
  });

  it('redacts failed tool result errors and details', () => {
    const result: ToolExecutionResult = {
      ok: false,
      toolName: 'run_command',
      error: {
        code: 'command_failed',
        message: `Bearer ${SENTINEL_SECRET}`,
        retryable: false,
        details: {
          stderr: `authorization=${SENTINEL_SECRET}`,
        },
      },
      meta: {
        durationMs: 1,
        timedOut: false,
      },
    };

    const redacted = redactToolResult(result, [SENTINEL_SECRET]);

    expect(JSON.stringify(redacted)).not.toContain(SENTINEL_SECRET);
  });
});
