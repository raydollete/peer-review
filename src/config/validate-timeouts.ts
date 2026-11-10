import { ConfigurationError } from '../shared/errors/index.js';
import type { EnvConfig } from './env.config.js';
import type { PeerReviewConfig } from './peer-config.js';
import type { CallerCeiling } from '../domain/use-cases/list-peers.use-case.js';

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

/**
 * The caller-ceiling pair: `PEER_REVIEW_DEADLINE_MS` MUST sit strictly below
 * the declared `PEER_REVIEW_CALLER_TIMEOUT_MS` (the MCP client's tool-call
 * timeout). Above it, the caller abandons the call at its own ceiling and
 * reports only its generic timeout — no verdict anyone computed is read.
 * The harness registration owner sets the client timeout; this server only
 * declares the value it assumes. A mismatch WARNs and keeps serving — a
 * slow-but-working server must not become a dead server whose only message is
 * one line on an unpersisted stderr — and is surfaced on `list_peers` and
 * every failure envelope while it holds.
 */
export function callerCeilingMismatch(env: EnvConfig): CallerCeiling | undefined {
  if (env.deadlineMs < env.callerTimeoutMs) {
    return undefined;
  }
  return {
    deadlineMs: env.deadlineMs,
    callerTimeoutMs: env.callerTimeoutMs,
    cause: 'configuration',
    fix:
      `PEER_REVIEW_DEADLINE_MS (${env.deadlineMs}ms) is not below ` +
      `PEER_REVIEW_CALLER_TIMEOUT_MS (${env.callerTimeoutMs}ms): lower the deadline, ` +
      `or raise the tool-call timeout in the harness registration`,
  };
}
