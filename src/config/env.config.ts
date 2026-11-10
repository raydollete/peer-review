import { z } from 'zod';
import { ConfigurationError } from '../shared/errors/index.js';

const EnvSchema = z.object({
  PEER_REVIEW_CONFIG: z.string().min(1).default('./peer-review.config.json'),
  PEER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  // Hard overall deadline for a peer_review or query_peer call (ms). MUST stay
  // strictly below PEER_REVIEW_CALLER_TIMEOUT_MS below — above the MCP client's
  // tool-call timeout the caller abandons the call and reports only its own
  // generic timeout, so no verdict anyone computed is read. The pair is checked
  // at startup (validate-timeouts.ts): a mismatch warns, never kills the server.
  PEER_REVIEW_DEADLINE_MS: z.coerce.number().int().positive().default(280000),
  // Declared MCP client tool-call timeout (ms) — the ceiling this server
  // assumes. The harness registration owner sets the real value (e.g. Quinn
  // derives its client timeout from the deadline plus transport margin; it is
  // omp's per-server `timeout` key). Nothing here can edit the registration, so
  // this is the single declared source of that number for the startup guard.
  PEER_REVIEW_CALLER_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
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
  readonly callerTimeoutMs: number;
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
    callerTimeoutMs: parsed.data.PEER_REVIEW_CALLER_TIMEOUT_MS,
    maxOutputTokens: parsed.data.PEER_MAX_OUTPUT_TOKENS,
    credentialTtlS: parsed.data.PEER_CREDENTIAL_TTL_S,
    skipLocal: parsed.data.PEER_REVIEW_SKIP_LOCAL,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
