import { ConfigurationError } from '../shared/errors/index.js';
import type { EnvConfig } from './env.config.js';
import type { PeerReviewConfig } from './peer-config.js';

/**
 * Startup guard: every configured tier wave plus its arbiter evaluation runs
 * sequentially on an escalated call, so their combined effective timeouts MUST
 * be strictly less than the global deadline.
 *
 * Effective timeout = a source's per-source `timeoutMs`, else the global
 * `PEER_TIMEOUT_MS` (`env.timeoutMs`). Each tier wave takes its slowest source
 * timeout (the peers run in parallel), then independently needs the arbiter
 * timeout. This guarantees an escalated run can honor every configured source
 * allowance without silently converting the final tier into a budget timeout.
 */
export function validateTimeoutsAgainstDeadline(config: PeerReviewConfig, env: EnvConfig): void {
  const effective = (timeoutMs: number | undefined): number => timeoutMs ?? env.timeoutMs;

  const arbiterSource = config.sources.find((s) => s.name === config.arbiter);
  // parsePeerConfig already guarantees the arbiter names a configured source.
  const arbiterTimeout = effective(arbiterSource?.timeoutMs);
  const maxByTier = new Map<number, { timeoutMs: number; sourceName: string }>();
  for (const source of config.sources) {
    const t = effective(source.timeoutMs);
    const current = maxByTier.get(source.tier);
    if (current === undefined || t > current.timeoutMs) {
      maxByTier.set(source.tier, { timeoutMs: t, sourceName: source.name });
    }
  }

  const tierBreakdown = [...maxByTier.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, source]) =>
      `tier ${tier}: ${source.sourceName} ${source.timeoutMs}ms + arbiter ${arbiterTimeout}ms`,
    );
  const requiredDeadlineMs = [...maxByTier.values()].reduce(
    (total, source) => total + source.timeoutMs + arbiterTimeout,
    0,
  );

  if (requiredDeadlineMs >= env.deadlineMs) {
    throw new ConfigurationError(
      `Timeout budget cannot fit every sequential tier wave plus arbiter: ` +
        `${tierBreakdown.join('; ')} = ${requiredDeadlineMs}ms is not strictly less than ` +
        `the deadline (PEER_REVIEW_DEADLINE_MS=${env.deadlineMs}ms). ` +
        `Lower a per-source timeoutMs / PEER_TIMEOUT_MS, or raise PEER_REVIEW_DEADLINE_MS.`,
    );
  }
}
