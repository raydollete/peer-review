import { z } from 'zod';
import { ConfigurationError } from '../shared/errors/index.js';

const EnvSchema = z.object({
  PEER_REVIEW_CONFIG: z.string().min(1).default('./peer-review.config.json'),
  PEER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  PEER_REVIEW_DEADLINE_MS: z.coerce.number().int().positive().default(240000),
  PEER_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  PEER_CREDENTIAL_TTL_S: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface EnvConfig {
  readonly configPath: string;
  readonly timeoutMs: number;
  readonly deadlineMs: number;
  readonly maxOutputTokens: number;
  readonly credentialTtlS: number;
  readonly logLevel: string;
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid environment configuration: ${detail}`);
  }
  return {
    configPath: parsed.data.PEER_REVIEW_CONFIG,
    timeoutMs: parsed.data.PEER_TIMEOUT_MS,
    deadlineMs: parsed.data.PEER_REVIEW_DEADLINE_MS,
    maxOutputTokens: parsed.data.PEER_MAX_OUTPUT_TOKENS,
    credentialTtlS: parsed.data.PEER_CREDENTIAL_TTL_S,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
