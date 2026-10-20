import { ConfigurationError } from '../shared/errors/index.js';
import type { EnvConfig } from './env.config.js';
import type { PeerReviewConfig } from './peer-config.js';

/**
 * Startup guard: the first tier wave plus its arbiter evaluation MUST be
 * strictly less than the global deadline, so a first verdict is always
 * reachable inside the wall.
 *
 * Effective timeout = a source's per-source `timeoutMs`, else the global
 * `PEER_TIMEOUT_MS` (`env.timeoutMs`). The first wave takes its slowest source
 * timeout (the peers run in parallel). Higher tiers are not summed: their
 * timeouts are ceilings, bounded at run time by the time remaining before the
 * deadline, never reservations the deadline must cover.
 */
export function validateTimeoutsAgainstDeadline(config: PeerReviewConfig, env: EnvConfig): void {
  const effective = (timeoutMs: number | undefined): number => timeoutMs ?? env.timeoutMs;

  const arbiterSource = config.sources.find((s) => s.name === config.arbiter);
  // parsePeerConfig already guarantees the arbiter names a configured source.
  const arbiterTimeout = effective(arbiterSource?.timeoutMs);
  const firstTier = Math.min(...config.sources.map((s) => s.tier));
  let slowest = { timeoutMs: 0, sourceName: '' };
  for (const source of config.sources.filter((s) => s.tier === firstTier)) {
    const t = effective(source.timeoutMs);
    if (t > slowest.timeoutMs) {
      slowest = { timeoutMs: t, sourceName: source.name };
    }
  }

  if (slowest.timeoutMs + arbiterTimeout >= env.deadlineMs) {
    throw new ConfigurationError(
      `Timeout budget cannot fit the first tier wave plus arbiter: ` +
        `tier ${firstTier}: ${slowest.sourceName} ${slowest.timeoutMs}ms + arbiter ${arbiterTimeout}ms = ` +
        `${slowest.timeoutMs + arbiterTimeout}ms is not strictly less than ` +
        `the deadline (PEER_REVIEW_DEADLINE_MS=${env.deadlineMs}ms). ` +
        `Lower PEER_TIMEOUT_MS or the first tier's/arbiter's timeoutMs, or raise PEER_REVIEW_DEADLINE_MS ` +
        `while keeping it below the MCP client's tool-call timeout.`,
    );
  }
}
