import { AgentCodeError, type PublicError } from '../../shared/errors.js';

export function createProviderStatusError(status: number): AgentCodeError {
  return new AgentCodeError(mapProviderStatus(status));
}

export function mapProviderStatus(status: number): PublicError {
  if (status === 401 || status === 403) {
    return {
      code: 'auth_error',
      message: `Provider rejected authentication with HTTP ${status}. Check api_key and provider access.`,
      retryable: false,
      status,
    };
  }

  if (status === 429) {
    return {
      code: 'rate_limit',
      message: 'Provider rate limit reached. Retry after a short delay.',
      retryable: true,
      status,
    };
  }

  if (status >= 500) {
    return {
      code: 'provider_error',
      message: `Provider returned HTTP ${status}.`,
      retryable: true,
      status,
    };
  }

  return {
    code: 'provider_error',
    message: `Provider request failed with HTTP ${status}.`,
    retryable: false,
    status,
  };
}

export function createNetworkError(message: string): AgentCodeError {
  return new AgentCodeError({
    code: 'network_error',
    message,
    retryable: true,
  });
}

export function createCancellationError(): AgentCodeError {
  return new AgentCodeError({
    code: 'network_error',
    message: 'Provider request was cancelled.',
    retryable: false,
  });
}

export function createProtocolError(message: string): AgentCodeError {
  return new AgentCodeError({
    code: 'protocol_error',
    message,
    retryable: false,
  });
}
