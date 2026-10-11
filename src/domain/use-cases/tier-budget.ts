import type { PeerSource } from '../ports/index.js';
import { ExternalServiceError } from '../errors/index.js';
import { markCancelled, markFailed, type MutableReport } from './source-reports.js';

/** Floor for a tier's time budget: the escalation timebox must never go
 * non-positive (which would abandon a tier before it can launch), even when the
 * remaining deadline is nearly exhausted. */
export const MIN_TIER_BUDGET_MS = 1;

/**
 * A tier's slice of the REMAINING deadline: an escalation timebox that reserves
 * the arbiter's evaluation and leaves room for the tiers still to come, so a
 * slow, contended lower tier is abandoned in time to still reach a healthy
 * higher one. Distinct from — and never overrunning — the terminal outer wall.
 */
export function computeTierBudget(
  deadlineMs: number,
  elapsedMs: number,
  tiersRemaining: number,
  arbiterReserveMs: number,
): number {
  const remaining = deadlineMs - elapsedMs;
  return Math.max(MIN_TIER_BUDGET_MS, Math.floor((remaining - arbiterReserveMs) / tiersRemaining));
}

/** Resolves once `signal` aborts (or immediately if already aborted) — one
 * listener the caller races the tier's in-flight peers against. */
export function signalAbortPromise<T>(signal: AbortSignal, value: T): Promise<T> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(value);
      return;
    }
    signal.addEventListener('abort', () => resolve(value), { once: true });
  });
}

/**
 * Tier budget elapsed with peers still in flight: a slow, contended backend.
 * Mark each still-launched source outage-shaped (its weight unattainable within
 * budget) so escalation to a healthy higher tier proceeds instead of blocking.
 */
export function markPendingOutage(
  inflight: Map<number, PeerSource>,
  reports: Map<string, MutableReport>,
): void {
  for (const source of inflight.values()) {
    const report = reports.get(source.name);
    if (report !== undefined && report.status === 'error') {
      markFailed(
        report,
        new ExternalServiceError('tier budget elapsed — still in flight', source.name),
      );
    }
  }
}

/**
 * Quorum met with peers still in flight: the early-abort cancels them. Mark each
 * still-launched source that never settled as cancelled — not needed, not failed.
 */
export function markPendingCancelled(
  inflight: Map<number, PeerSource>,
  reports: Map<string, MutableReport>,
): void {
  for (const source of inflight.values()) {
    const report = reports.get(source.name);
    if (report !== undefined && report.status === 'error') {
      markCancelled(report);
    }
  }
}
