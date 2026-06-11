import { createProtocolError } from './errors.js';

export function joinEndpoint(baseUrl: string, endpointPath: string): string {
  const parsedBaseUrl = new URL(baseUrl.trim());
  if (parsedBaseUrl.search !== '' || parsedBaseUrl.hash !== '') {
    throw createProtocolError('Provider baseUrl cannot include query parameters or hash fragments.');
  }

  parsedBaseUrl.pathname = ensureTrailingSlash(parsedBaseUrl.pathname);

  const normalizedEndpointPath = endpointPath.replace(/^\/+/, '');
  return new URL(normalizedEndpointPath, parsedBaseUrl).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
