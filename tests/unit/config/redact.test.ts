import { describe, expect, it } from 'vitest';

import { redactSecret, redactText } from '../../../src/config/redact.js';

describe('redactSecret', () => {
  it('keeps a short stable marker for empty and short secrets', () => {
    expect(redactSecret('')).toBe('<empty>');
    expect(redactSecret('short')).toBe('<redacted>');
  });

  it('keeps only the prefix and suffix for longer secrets', () => {
    expect(redactSecret('sk-ant-1234567890')).toBe('sk-a…7890');
  });
});

describe('redactText', () => {
  it('replaces every occurrence of known secrets', () => {
    const sentinelKey = 'sk-test-sentinel-config-secret';
    const message = `first ${sentinelKey}, second ${sentinelKey}`;

    const redacted = redactText(message, [sentinelKey]);

    expect(redacted).not.toContain(sentinelKey);
    expect(redacted).toContain('sk-t…cret');
  });
});
