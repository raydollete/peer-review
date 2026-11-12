import type { PeerSource } from '../ports/index.js';
import { TierBudgetElapsedError } from '../errors/index.js';
import {
  abortedByRun,
  cancellationNote,
  markCancelled,
  markFailed,
  type AbortAttribution,
  type MutableReport,
} from './source-reports.js';

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
 * The tier's signal fired with peers still in flight. Two different endings
 * arrive here and MUST be reported apart: the tier's own time budget elapsed
 * (a slow, contended backend → mark each still-launched source outage-shaped so
 * its weight is unattainable within budget and escalation proceeds), or the run
 * / caller walked away (not the peer's fault → itemize as cancelled, never as a
 * tier-budget outage). Attribution comes from the run's origin flags, not from
 * the error the request settled with.
 */
export function markPendingOutage(
  inflight: Map<number, PeerSource>,
  reports: Map<string, MutableReport>,
  attribution: AbortAttribution,
): void {
  for (const source of inflight.values()) {
    const report = reports.get(source.name);
    if (report === undefined || report.status !== 'error') {
      continue;
    }
    if (abortedByRun(attribution)) {
      markCancelled(report, cancellationNote(attribution));
      continue;
    }
    markFailed(
      report,
      new TierBudgetElapsedError('tier budget elapsed — still in flight', source.name),
    );
  }
}

/**
 * Quorum met with peers still in flight: the early-abort cancels them. Mark each
 * still-launched source that never settled as cancelled — not needed, not failed.
 * The wall still wins: if it expired first, these rows are the wall's stragglers
 * and must keep the failure shape `markDeadlineStragglers` gives them — a
 * cancelled row there would hide a real deadline miss (F3).
 */
export function markPendingCancelled(
  inflight: Map<number, PeerSource>,
  reports: Map<string, MutableReport>,
  attribution: AbortAttribution,
): void {
  if (attribution.deadlineHit) {
    return;
  }
  for (const source of inflight.values()) {
    const report = reports.get(source.name);
    if (report !== undefined && report.status === 'error') {
      markCancelled(report, cancellationNote(attribution));
    }
  }
}
