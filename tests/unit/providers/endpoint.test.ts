import { describe, expect, it } from 'vitest';

import { joinEndpoint } from '../../../src/providers/shared/endpoint.js';

describe('joinEndpoint', () => {
  it.each([
    ['https://api.example.com', '/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/', 'v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1', '/chat/completions', 'https://api.example.com/v1/chat/completions'],
    [
      'https://proxy.example.com/custom/openai/v1/',
      '/chat/completions',
      'https://proxy.example.com/custom/openai/v1/chat/completions',
    ],
  ])('joins %s and %s', (baseUrl, endpointPath, expectedUrl) => {
    expect(joinEndpoint(baseUrl, endpointPath)).toBe(expectedUrl);
  });

  it.each([
    'https://proxy.example.com/custom/openai/v1?tenant=a',
    'https://proxy.example.com/custom/openai/v1/?tenant=a',
    'https://proxy.example.com/custom/openai/v1#fragment',
  ])('rejects base URLs with query or hash components: %s', (baseUrl) => {
    expect(() => joinEndpoint(baseUrl, '/chat/completions')).toThrow(
      'baseUrl cannot include query parameters or hash fragments',
    );
  });
});
