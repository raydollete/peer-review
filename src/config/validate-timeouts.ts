import { ConfigurationError } from '../shared/errors/index.js';
import type { EnvConfig } from './env.config.js';
import type { PeerReviewConfig } from './peer-config.js';

/**
 * Startup guard: the largest source effective request timeout plus the arbiter's
 * effective request timeout MUST be strictly less than the global deadline.
 *
 * Effective timeout = a source's per-source `timeoutMs`, else the global
 * `PEER_TIMEOUT_MS` (`env.timeoutMs`). This guarantees at least one full tier
 * wave plus one arbiter evaluation fits inside the deadline — so no single slow
 * source can consume the entire wall and silently disable escalation (the miss
 * would present only as a mysterious run-time timeout). Enforced loudly here
 * rather than surfacing at run time.
 */
export function validateTimeoutsAgainstDeadline(config: PeerReviewConfig, env: EnvConfig): void {
  const effective = (timeoutMs: number | undefined): number => timeoutMs ?? env.timeoutMs;

  let maxSourceTimeout = 0;
  let maxSourceName = '';
  for (const source of config.sources) {
    const t = effective(source.timeoutMs);
    if (t > maxSourceTimeout) {
      maxSourceTimeout = t;
      maxSourceName = source.name;
    }
  }

  const arbiterSource = config.sources.find((s) => s.name === config.arbiter);
  // parsePeerConfig already guarantees the arbiter names a configured source.
  const arbiterTimeout = effective(arbiterSource?.timeoutMs);

  if (maxSourceTimeout + arbiterTimeout >= env.deadlineMs) {
    throw new ConfigurationError(
      `Timeout budget cannot fit one wave plus arbiter: the largest source timeout ` +
        `(${maxSourceName}: ${maxSourceTimeout}ms) plus the arbiter timeout ` +
        `(${config.arbiter}: ${arbiterTimeout}ms) = ${maxSourceTimeout + arbiterTimeout}ms is not ` +
        `strictly less than the deadline (PEER_REVIEW_DEADLINE_MS=${env.deadlineMs}ms). ` +
        `A single slow source would then consume the whole deadline and disable escalation. ` +
        `Lower a per-source timeoutMs / PEER_TIMEOUT_MS, or raise PEER_REVIEW_DEADLINE_MS.`,
    );
  }
}
