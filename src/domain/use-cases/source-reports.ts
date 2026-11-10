import type { PeerSource } from '../ports/index.js';
import { ConfigurationError, ExternalServiceError, TimeoutError, type DomainError } from '../errors/index.js';
import { causeOf, type PeerReviewFailureCause } from '../errors/index.js';

/** Per-source bookkeeping while a quorum run is in flight; frozen into
 * QuorumSourceReport when the run finalizes. */
export interface MutableReport {
  name: string;
  model: string;
  status: 'ok' | 'error' | 'unavailable' | 'skipped' | 'cancelled';
  weight: number;
  agreement: number | null;
  error?: string | undefined;
  /** Machine cause from the typed error that failed this source; absent for
   * ok/cancelled. Kept typed so a roster entry separates 401 from timeout by
   * class, not only by prose. */
  cause?: PeerReviewFailureCause | undefined;
  code?: string | undefined;
  service?: string | undefined;
  timeoutMs?: number | undefined;
}

/** A source starts non-ok and only earns "ok" by settling successfully. The
 * seeded reason matters: a source that never settles at all (global deadline
 * hit) would otherwise report a bare "error" status, which the caller — who
 * sees only this envelope — cannot diagnose. */
export function seedReport(source: PeerSource): MutableReport {
  return {
    name: source.name,
    model: source.model,
    status: source.available ? 'error' : 'unavailable',
    weight: source.weight,
    agreement: null,
    error: source.available
      ? 'No response recorded before the run ended'
      : 'Credential not resolvable; source skipped',
    ...(source.available ? {} : { cause: 'credential' as const }),
  };
}

export function markOk(report: MutableReport): void {
  report.status = 'ok';
  delete report.error;
  delete report.cause;
  delete report.code;
  delete report.service;
  delete report.timeoutMs;
}

export function markFailed(report: MutableReport, error: DomainError): void {
  report.status = error instanceof ConfigurationError ? 'unavailable' : 'error';
  report.error = error.message;
  // Typed fields, not only prose: the code, the service an external error
  // named, and the budget a TimeoutError exceeded ride into sources[].
  report.cause = causeOf(error);
  report.code = error.code;
  if (error instanceof ExternalServiceError) {
    report.service = error.service;
  }
  if (error instanceof TimeoutError) {
    report.timeoutMs = error.timeoutMs;
  }
}

/** Excluded as a redundant peer for this request — either the caller declared it
 * IS this source (`callerSource`) or the caller is local and so is this source
 * (`skipLocal`); both can hold at once. Never called, zero quorum weight, but
 * itemized so the exclusion is transparent rather than a silent gap in
 * `sources[]`. */
export function markSkipped(
  report: MutableReport,
  reason = 'Skipped: excluded as a redundant peer for this request (callerSource/skipLocal)',
  cause: PeerReviewFailureCause = 'configuration',
): void {
  report.status = 'skipped';
  report.agreement = null;
  report.error = reason;
  report.cause = cause;
}

/** Escalation reached a tier with no time left before the deadline after the
 * arbiter reserve: none of its sources is called, each itemized as skipped. */
export function markTierSkippedForTime(
  sources: readonly PeerSource[],
  reports: Map<string, MutableReport>,
): void {
  for (const source of sources) {
    const report = seedReport(source);
    markSkipped(report, 'Skipped: no time left before the deadline after the arbiter reserve');
    reports.set(source.name, report);
  }
}

/** The global wall expired while this source never settled: it keeps its
 * seeded reason but reports the cause it died of — the deadline — with the
 * budget that expired, not only prose. */
export function markDeadlineStraggler(report: MutableReport, timeoutMs: number): void {
  report.status = 'error';
  report.cause = 'deadline';
  report.timeoutMs = timeoutMs;
}

/** Still in flight when the quorum was met, so the early-abort cancelled it.
 * Not a failure — the run no longer needed its vote — so it carries zero quorum
 * weight and is itemized distinctly from "error" rather than as a degraded peer. */
export function markCancelled(report: MutableReport): void {
  report.status = 'cancelled';
  report.agreement = null;
  report.error = 'Cancelled: quorum was met before this source responded';
}

/** Honor the caller's cancellation: an `extra.signal` abort (the harness's
 * notifications/cancelled) ends the run instead of billing peers to the wall.
 * Returns the detach for the finally block. */
export function attachCallerAbort(
  controller: AbortController,
  callerSignal?: AbortSignal,
): () => void {
  if (callerSignal === undefined) {
    return () => undefined;
  }
  const onAbort = (): void => {
    controller.abort();
  };
  if (callerSignal.aborted) {
    onAbort();
    return () => undefined;
  }
  callerSignal.addEventListener('abort', onAbort, { once: true });
  return () => {
    callerSignal.removeEventListener('abort', onAbort);
  };
}

/** The subset of run state the straggler pass needs (kept structural so this
 * module stays the single home of report bookkeeping). */
export interface StragglerState {
  deadlineHit: boolean;
  reports: Map<string, MutableReport>;
  settled: Set<string>;
}

/** The wall expired: sources that never settled carry cause 'deadline' with
 * the budget that expired, not only the seeded prose (task 15). */
export function markDeadlineStragglers(state: StragglerState, deadlineMs: number): void {
  if (!state.deadlineHit) {
    return;
  }
  for (const report of state.reports.values()) {
    if (report.status === 'error' && !state.settled.has(report.name)) {
      markDeadlineStraggler(report, deadlineMs);
    }
  }
}

/** A3: an unknown callerSource is a logged no-op, never a crash — the caller
 * may be pointed at a differently-configured server than it assumes. */
export function noteUnknownCallerSource(
  input: { callerSource?: string | undefined },
  sources: readonly { name: string }[],
  logger?: { warn: (message: string, context?: Record<string, unknown>) => void },
): void {
  if (input.callerSource !== undefined && !sources.some((s) => s.name === input.callerSource)) {
    logger?.warn('callerSource names no configured source; ignoring', {
      callerSource: input.callerSource,
    });
  }
}
