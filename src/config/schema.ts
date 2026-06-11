import { z } from 'zod';

export type ProviderProtocol = 'anthropic' | 'openai';

export interface RawConfig {
  protocol: ProviderProtocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking?: {
    enabled?: boolean | undefined;
    budget_tokens?: number | undefined;
  } | undefined;
  request?: {
    timeout_ms?: number | undefined;
    headers?: Record<string, string> | undefined;
  } | undefined;
  ui?: {
    show_thinking?: boolean | undefined;
  } | undefined;
}

export interface AgentConfig {
  protocol: ProviderProtocol;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: {
    enabled: boolean;
    budgetTokens?: number;
  };
  request: {
    timeoutMs: number;
    headers: Record<string, string>;
  };
  ui: {
    showThinking: boolean;
  };
}

export interface ResolvedConfig {
  source: 'project' | 'global';
  path: string;
  config: AgentConfig;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const AUTH_HEADER_NAME_MARKERS = ['auth', 'apikey', 'token', 'jwt', 'cookie', 'session', 'credential'] as const;

const headersSchema = z
  .record(z.string().min(1), z.string())
  .default({})
  .refine(
    (headers) => !Object.keys(headers).some((name) => isAuthHeaderName(name)),
    'request.headers cannot contain authentication headers; use api_key instead'
  );

function isAuthHeaderName(name: string): boolean {
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  return AUTH_HEADER_NAME_MARKERS.some((marker) => normalizedName.includes(marker));
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function hasNoSearchOrHash(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.search === '' && parsedUrl.hash === '';
  } catch {
    return false;
  }
}

export const rawConfigSchema = z
  .object({
    protocol: z.enum(['anthropic', 'openai']),
    model: z.string().trim().min(1, 'model is required'),
    base_url: z
      .string()
      .trim()
      .url('base_url must be a valid URL')
      .refine((url) => isHttpUrl(url), 'base_url must use http or https')
      .refine((url) => hasNoSearchOrHash(url), 'base_url cannot include query parameters or hash fragments'),
    api_key: z.string().trim().min(1, 'api_key is required'),
    thinking: z
      .object({
        enabled: z.boolean().optional(),
        budget_tokens: z.number().int().positive().optional()
      })
      .optional(),
    request: z
      .object({
        timeout_ms: z.number().int().positive().optional(),
        headers: headersSchema.optional()
      })
      .optional(),
    ui: z
      .object({
        show_thinking: z.boolean().optional()
      })
      .optional()
  })
  .strict();

export function parseRawConfig(value: unknown): RawConfig {
  return rawConfigSchema.parse(value);
}

export function normalizeConfig(rawConfig: RawConfig): AgentConfig {
  const thinking: AgentConfig['thinking'] = {
    enabled: rawConfig.thinking?.enabled ?? false
  };

  if (rawConfig.thinking?.budget_tokens !== undefined) {
    thinking.budgetTokens = rawConfig.thinking.budget_tokens;
  }

  return {
    protocol: rawConfig.protocol,
    model: rawConfig.model,
    baseUrl: rawConfig.base_url,
    apiKey: rawConfig.api_key,
    thinking,
    request: {
      timeoutMs: rawConfig.request?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      headers: rawConfig.request?.headers ?? {}
    },
    ui: {
      showThinking: rawConfig.ui?.show_thinking ?? false
    }
  };
}
