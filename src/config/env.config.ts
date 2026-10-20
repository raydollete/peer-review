import { z } from 'zod';
import { ConfigurationError } from '../shared/errors/index.js';

const EnvSchema = z.object({
  PEER_REVIEW_CONFIG: z.string().min(1).default('./peer-review.config.json'),
  PEER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  // Must stay strictly below the MCP client's tool-call timeout (300 s under
  // radflow, Codex, and omp) so the partial result reaches a caller still
  // waiting; 280 s leaves ~20 s for transport and serialization. Escalated
  // tiers get whatever time remains.
  PEER_REVIEW_DEADLINE_MS: z.coerce.number().int().positive().default(280000),
  PEER_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  PEER_CREDENTIAL_TTL_S: z.coerce.number().int().positive().default(3000),
  // When true, sources flagged `local` in config are excluded from the quorum —
  // set per-harness in that harness's MCP registration env block when the caller
  // itself runs on the local backend. Accepts "true"/"1"/"false"/"0"/unset.
  PEER_REVIEW_SKIP_LOCAL: z
    .enum(['true', '1', 'false', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface EnvConfig {
  readonly configPath: string;
  readonly timeoutMs: number;
  readonly deadlineMs: number;
  readonly maxOutputTokens: number;
  readonly credentialTtlS: number;
  readonly skipLocal: boolean;
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
    skipLocal: parsed.data.PEER_REVIEW_SKIP_LOCAL,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
