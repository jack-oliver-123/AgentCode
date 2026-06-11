export type PublicErrorCode =
  | 'config_error'
  | 'auth_error'
  | 'network_error'
  | 'rate_limit'
  | 'provider_error'
  | 'protocol_error'
  | 'unknown_error';

export interface PublicError {
  code: PublicErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
}

export class AgentCodeError extends Error {
  readonly publicError: PublicError;

  constructor(publicError: PublicError) {
    super(publicError.message);
    this.name = 'AgentCodeError';
    this.publicError = publicError;
  }
}

const SENSITIVE_JSON_KEY = String.raw`(?:api\s*key|api[_-]?key|x-api-key|authorization|token|jwt)`;
const DOUBLE_QUOTED_JSON_SECRET_PATTERN = new RegExp(
  `(["']${SENSITIVE_JSON_KEY}["']\\s*:\\s*")((?:\\\\.|[^"\\\\])*)(")`,
  'gi'
);
const SINGLE_QUOTED_JSON_SECRET_PATTERN = new RegExp(
  `(["']${SENSITIVE_JSON_KEY}["']\\s*:\\s*')((?:\\\\.|[^'\\\\])*)(')`,
  'gi'
);

export function toPublicError(error: unknown): PublicError {
  if (error instanceof AgentCodeError) {
    return {
      ...error.publicError,
      message: redactPublicMessage(error.publicError.message)
    };
  }

  if (error instanceof Error) {
    return {
      code: 'unknown_error',
      message: redactPublicMessage(error.message),
      retryable: false
    };
  }

  return {
    code: 'unknown_error',
    message: redactPublicMessage(String(error)),
    retryable: false
  };
}

function redactPublicMessage(message: string): string {
  return message
    .replace(DOUBLE_QUOTED_JSON_SECRET_PATTERN, '$1<redacted>$3')
    .replace(SINGLE_QUOTED_JSON_SECRET_PATTERN, '$1<redacted>$3')
    .replace(/(?<!["'])authorization\s*[:=]\s*[^\r\n]+/gi, 'authorization: <redacted>')
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(/((?:api\s*key|api[_-]?key|token|jwt)\s*[:=]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, 'sk-<redacted>');
}
