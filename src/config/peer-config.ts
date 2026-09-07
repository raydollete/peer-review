import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CALLER_SOURCE_NAME } from '../domain/use-cases/agreement-prompt.js';
import { ConfigurationError } from '../shared/errors/index.js';

const SourceSchema = z.object({
  name: z.string().min(1),
  apiType: z.enum(['openai', 'anthropic']),
  // Adapters append "/chat/completions" (or "/v1/messages"), so a trailing
  // slash here would produce a double slash — OpenRouter answers those with 404.
  baseUrl: z
    .string()
    .url()
    .transform((url) => url.replace(/\/+$/, '')),
  model: z.string().min(1),
  apiKeyEnv: z.string().min(1).optional(),
  apiKeyCommand: z.string().min(1).optional(),
  weight: z.number().int().positive(),
  tier: z.number().int().positive(),
  // Per-source overrides for the global PEER_TIMEOUT_MS / PEER_MAX_OUTPUT_TOKENS
  // envelopes — reasoning models need longer timeouts and larger output budgets
  // (hidden thinking is billed against max_tokens before the answer).
  timeoutMs: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  // Marks a source served by the local inference backend. When a caller is
  // itself running on that backend (PEER_REVIEW_SKIP_LOCAL), consulting it is
  // self-contention, so it is skipped for the request. Locality, not model id.
  local: z.boolean().optional(),
  // Opt-in structured-output request for the arbiter. OpenAI-compatible
  // sources only — the anthropic wire format has no equivalent, so
  // cross-validation rejects it there.
  jsonMode: z.boolean().optional(),
});

const TIER_KEY_PATTERN = /^(?:tier)?([0-9]+)$/;

const ConfigFileSchema = z.object({
  thresholds: z.record(
    z.string().regex(TIER_KEY_PATTERN, 'threshold keys must be "tierN" or "N"'),
    z.number().int().positive(),
  ),
  arbiter: z.string().min(1),
  sources: z.array(SourceSchema).min(1),
});

export type SourceConfig = z.infer<typeof SourceSchema>;

export interface PeerReviewConfig {
  readonly thresholds: Readonly<Record<number, number>>;
  readonly arbiter: string;
  readonly sources: readonly SourceConfig[];
}

function normalizeThresholds(raw: Record<string, number>): Record<number, number> {
  const thresholds: Record<number, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const match = TIER_KEY_PATTERN.exec(key);
    if (match?.[1] !== undefined) {
      thresholds[Number.parseInt(match[1], 10)] = value;
    }
  }
  return thresholds;
}

function crossValidate(config: PeerReviewConfig): void {
  const names = new Set<string>();
  for (const source of config.sources) {
    if (source.name === CALLER_SOURCE_NAME) {
      throw new ConfigurationError(
        `Source name "${CALLER_SOURCE_NAME}" is reserved for the caller-answer rating channel`,
      );
    }
    if (names.has(source.name)) {
      throw new ConfigurationError(`Duplicate source name: "${source.name}"`);
    }
    names.add(source.name);

    const hasEnv = source.apiKeyEnv !== undefined;
    const hasCommand = source.apiKeyCommand !== undefined;
    if (hasEnv === hasCommand) {
      throw new ConfigurationError(
        `Source "${source.name}" must declare exactly one of apiKeyEnv or apiKeyCommand`,
      );
    }

    if (config.thresholds[source.tier] === undefined) {
      throw new ConfigurationError(
        `Source "${source.name}" uses tier ${source.tier} but no threshold is configured for it`,
      );
    }

    if (source.jsonMode === true && source.apiType === 'anthropic') {
      throw new ConfigurationError(
        `Source "${source.name}" declares jsonMode but apiType "anthropic" has no structured-output mode`,
      );
    }
  }

  if (!names.has(config.arbiter)) {
    throw new ConfigurationError(`Arbiter "${config.arbiter}" is not a configured source name`);
  }
}

export function parsePeerConfig(raw: unknown): PeerReviewConfig {
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid peer-review config: ${detail}`);
  }

  const config: PeerReviewConfig = {
    thresholds: normalizeThresholds(parsed.data.thresholds),
    arbiter: parsed.data.arbiter,
    sources: parsed.data.sources,
  };
  crossValidate(config);
  return config;
}

export function loadPeerConfig(filePath: string): PeerReviewConfig {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigurationError(`Cannot read config file "${filePath}": ${String(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigurationError(`Config file "${filePath}" is not valid JSON: ${String(error)}`);
  }

  return parsePeerConfig(raw);
}

/** A source is available when its credential is resolvable without calling anything. */
export function sourceAvailable(
  source: SourceConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (source.apiKeyEnv !== undefined) {
    const value = env[source.apiKeyEnv];
    return value !== undefined && value.length > 0;
  }
  return true;
}
