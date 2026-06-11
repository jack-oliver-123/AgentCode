import { describe, expect, it } from 'vitest';

import { AgentCodeError, toPublicError } from '../../../src/shared/errors.js';

describe('toPublicError', () => {
  it.each([
    ['api_key value', 'Failed with api_key=sk-test-shared-secret-123', 'sk-test-shared-secret-123'],
    ['API key label', 'Failed with API key: raw-api-key-123456', 'raw-api-key-123456'],
    ['JSON api_key value', 'Failed with {"api_key":"plain-secret-123"}', 'plain-secret-123'],
    ['JSON x-api-key value', 'Failed with {"x-api-key":"plain-x-secret-123"}', 'plain-x-secret-123'],
    ['JSON authorization value', 'Failed with {"authorization":"Basic raw-basic-secret"}', 'raw-basic-secret'],
    ['JSON authorization token value', 'Failed with {"authorization":"Token raw-token-secret"}', 'raw-token-secret'],
    ['JSON authorization raw value', 'Failed with {"authorization":"raw-authorization-secret"}', 'raw-authorization-secret'],
    [
      'JSON digest authorization value',
      'Failed with {"authorization":"Digest foo, response=secret-digest-value"}',
      'secret-digest-value'
    ],
    ['Digest authorization header', 'Failed with Authorization: Digest foo, response=secret-digest-value', 'secret-digest-value'],
    ['Bearer authorization', 'Failed with Authorization: Bearer raw-token-123', 'raw-token-123'],
    ['Basic authorization', 'Failed with Authorization: Basic dXNlcjpzZWNyZXQ=', 'dXNlcjpzZWNyZXQ='],
    ['bare bearer token', 'Failed with Bearer raw-bearer-token-123', 'raw-bearer-token-123'],
    ['jwt label', 'Failed with jwt: eyJhbGciOiJIUzI1NiJ9.secret', 'eyJhbGciOiJIUzI1NiJ9.secret'],
    [
      'bare JWT shape',
      'provider returned jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456'
    ]
  ])('redacts %s from ordinary errors', (_caseName, message, secret) => {
    const publicError = toPublicError(new Error(message));

    expect(publicError.message).not.toContain(secret);
    expect(publicError.message).toContain('<redacted>');
  });

  it('redacts common secret patterns from AgentCodeError messages', () => {
    const publicError = toPublicError(
      new AgentCodeError({
        code: 'config_error',
        message: 'Invalid token: sk-test-agentcode-secret-456',
        retryable: false
      })
    );

    expect(publicError).toMatchObject({
      code: 'config_error',
      retryable: false
    });
    expect(publicError.message).not.toContain('sk-test-agentcode-secret-456');
    expect(publicError.message).toContain('<redacted>');
  });

  it('redacts common secret patterns from non-error values', () => {
    const publicError = toPublicError('token=sk-test-string-secret-789');

    expect(publicError.message).not.toContain('sk-test-string-secret-789');
    expect(publicError.message).toContain('token=<redacted>');
  });
});
