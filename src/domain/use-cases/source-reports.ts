import type { Result } from 'neverthrow';
import type { PeerSource } from '../ports/index.js';
import type { PeerResponse } from '../entities/index.js';
import {
  CancellationError,
  ConfigurationError,
  ExternalServiceError,
  TimeoutError,
  type DomainError,
} from '../errors/index.js';
import { causeOf, type PeerReviewFailureCause } from '../errors/index.js';
import type { ILogger } from '../../shared/logger/index.js';

/** Per-source bookkeeping while a quorum run is in flight; frozen into
 * QuorumSourceReport when the run finalizes. */
export interface MutableReport {
  name: string;
  model: string;
  status: 'ok' | 'error' | 'unavailable' | 'skipped' | 'cancelled';
  /** Effective contribution to this run: the configured weight, except 0 on a
   * `cancelled` row (see markCancelled). */
  weight: number;
  agreement: number | null;
  /** The arbiter's one-line reason; set only alongside a rating. */
  reason?: string | undefined;
  /** Failure slot: why this source FAILED. Cleared by markOk and markCancelled. */
  error?: string | undefined;
  /** Machine cause from the typed error that failed this source; absent for
   * ok/cancelled. Kept typed so a roster entry separates 401 from timeout by
   * class, not only by prose. */
  cause?: PeerReviewFailureCause | undefined;
  code?: string | undefined;
  service?: string | undefined;
  timeoutMs?: number | undefined;
  /** Non-failure reason, set on `cancelled` rows (the run or the caller ended
   * the request) and on `ok` rows left unrated. Kept out of `error` so
   * failure-counting readers skip it. */
  note?: string | undefined;
}

/** `note` texts for an `ok` row with no rating — prose for humans; the machine
 * signal is `status: 'ok'` with `agreement: null`. */
export const UNRATED_OMITTED = 'Unrated: the arbiter returned no rating for this source';
export const UNRATED_ARBITER_FAILED = 'Unrated: the arbiter failed; see quorum.arbiter';
export const UNRATED_RUN_ENDED = 'Unrated: the run ended before the arbiter rated this source';
/** `note` on a row that keeps an earlier evaluation's rating after a later one failed. */
export const RATED_BEFORE_ARBITER_FAILED =
  'Rated by an earlier evaluation; the latest arbiter evaluation failed — see quorum.arbiter';

/** A later evaluation failed: an earlier rating stays itemized (with its reason)
 * but says it is not the latest verdict; a row never rated says it is unrated. */
export function markArbiterFailed(report: MutableReport): void {
  if (report.agreement === null) {
    markRated(report, undefined, UNRATED_ARBITER_FAILED);
  } else {
    report.note = RATED_BEFORE_ARBITER_FAILED;
  }
}

/** Record one evaluation's verdict on a successful source: a rating (with its
 * reason, clearing any earlier note), or unrated with the note naming why. Every
 * completed evaluation rewrites every success row. */
export function markRated(
  report: MutableReport,
  rating: { readonly agreement: number; readonly reason?: string } | undefined,
  unratedNote: string,
): void {
  report.agreement = rating?.agreement ?? null;
  delete report.reason;
  delete report.note;
  if (rating === undefined) {
    report.note = unratedNote;
  } else if (rating.reason !== undefined) {
    report.reason = rating.reason;
  }
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

/** Clear every failure slot. Filled only by markFailed, and cleared by the two
 * mutators that mean "this source did not fail" — markOk and markCancelled — so
 * the two shapes can never drift apart. */
function clearFailureSlots(report: MutableReport): void {
  delete report.error;
  delete report.cause;
  delete report.code;
  delete report.service;
  delete report.timeoutMs;
}

export function markOk(report: MutableReport): void {
  report.status = 'ok';
  clearFailureSlots(report);
}

export function markFailed(report: MutableReport, error: DomainError): void {
  report.status = error instanceof ConfigurationError ? 'unavailable' : 'error';
  delete report.reason;
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
  delete report.reason;
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

/** Who ended a peer's request. The run sets these flags from dedicated listeners
 * at the moment each clock or abort fires, so attribution is by origin — never by
 * error text, and never by which observation the orchestrator saw first. */
export interface AbortOriginFlags {
  /** The run's own controller aborted: early-abort after quorum, the caller
   * cancelling, or the final unwind. */
  runAborted: boolean;
  /** This tier's peer time budget elapsed. */
  tierClockFired: boolean;
  /** The caller's `extra.signal` aborted. */
  callerCancelled: boolean;
  /** The global wall expired. */
  deadlineHit: boolean;
}

/** The read-only view the attribution rule takes. */
export type AbortAttribution = Readonly<AbortOriginFlags>;

/** The flags at run start: nothing has fired yet. */
export function initialAbortAttribution(): AbortOriginFlags {
  return {
    runAborted: false,
    tierClockFired: false,
    callerCancelled: false,
    deadlineHit: false,
  };
}

/** The single home of the rule — **a clock that expired fails a peer; an abort
 * the run caused cancels it.** True only when the run's own abort ended the
 * request and neither clock was responsible, so a peer cut off by the wall or by
 * its tier budget stays a failure while a peer the run walked away from does not.
 * Both observation orders of one abort answer the same way. */
export function abortedByRun(state: AbortAttribution): boolean {
  return state.runAborted && !state.tierClockFired && !state.deadlineHit;
}

/** The one attribution decision for a SETTLED error, consulted at every site that
 * used to guess: the run (or the caller) ended this request and the settled error
 * IS that abort. Classify by origin and typed error only, never by error text, so
 * both observation orders of one abort produce one verdict. */
export function isRunCancellation(state: AbortAttribution, error: DomainError): boolean {
  return abortedByRun(state) && error instanceof CancellationError;
}

/** Roster `note` texts for the two run-caused aborts — prose for humans; the
 * machine class is `status: 'cancelled'`. */
const CANCELLED_AFTER_QUORUM = 'Cancelled: quorum was met before this source responded';
const CANCELLED_BY_CALLER = 'Cancelled: the caller cancelled the call before this source responded';

/** The note naming the run-caused abort that covered this source. */
export function cancellationNote(state: AbortAttribution): string {
  return state.callerCancelled ? CANCELLED_BY_CALLER : CANCELLED_AFTER_QUORUM;
}

/** The run no longer needed this peer's vote — still in flight, or just settled
 * with its own abort error, when the run walked away. Not a failure and not a
 * degraded peer: zero effective weight, the reason in `note`, and every failure
 * slot cleared through `clearFailureSlots`, so a reader counting failures off a
 * populated `error` cannot count it. */
export function markCancelled(report: MutableReport, reason: string): void {
  report.status = 'cancelled';
  report.agreement = null;
  delete report.reason;
  report.weight = 0;
  report.note = reason;
  clearFailureSlots(report);
}

/** Honor the caller's cancellation: an `extra.signal` abort (the harness's
 * notifications/cancelled) ends the run instead of billing peers to the wall.
 * `onCallerAbort` records the origin BEFORE the controller aborts, so listeners
 * on the run signal see the attribution already in place. Returns the detach for
 * the finally block. */
export function attachCallerAbort(
  controller: AbortController,
  callerSignal?: AbortSignal,
  onCallerAbort?: () => void,
): () => void {
  if (callerSignal === undefined) {
    return () => undefined;
  }
  const onAbort = (): void => {
    onCallerAbort?.();
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

/** Install the two origin listeners a run needs before anything can abort: its
 * own controller, and the caller's `extra.signal` through attachCallerAbort.
 * Returns the caller detach for the finally block. The run listener MUST be added
 * first — a caller signal that is already aborted aborts the controller
 * synchronously, and a listener added after an abort never fires. */
export function watchAbortOrigins(
  flags: AbortOriginFlags,
  controller: AbortController,
  callerSignal?: AbortSignal,
): () => void {
  controller.signal.addEventListener(
    'abort',
    () => {
      flags.runAborted = true;
    },
    { once: true },
  );
  return attachCallerAbort(controller, callerSignal, () => {
    flags.callerCancelled = true;
  });
}

/** The subset of run state the straggler passes need (kept structural so this
 * module stays the single home of report bookkeeping). */
export interface StragglerState extends AbortOriginFlags {
  reports: Map<string, MutableReport>;
  settled: Set<string>;
}

/** The settled outcome of one peer request, as the orchestrator races them. */
export interface Settled {
  readonly source: PeerSource;
  readonly result: Result<PeerResponse, DomainError>;
}

/** The subset of run state a settled peer folds in (structural, so this module
 * stays the single home of report bookkeeping). */
export interface RecordState extends StragglerState {
  successes: Array<{ source: PeerSource; response: PeerResponse }>;
  usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number; totalTokens: number };
}

/** Fold one settled peer into the run: its roster row, the success list, and the
 * token usage. A run- or caller-caused abort is itemized as cancelled and logged
 * at debug; every other error is a peer-side failure and keeps the alertable
 * warn, so a 401/429 that settles inside the abort window still reports its own
 * cause. */
export function recordSettled(
  state: RecordState,
  settled: Settled,
  logger?: Pick<ILogger, 'warn' | 'debug'> | undefined,
): void {
  const report = state.reports.get(settled.source.name);
  if (report === undefined) {
    return;
  }
  state.settled.add(settled.source.name);
  if (settled.result.isOk()) {
    markOk(report);
    state.successes.push({ source: settled.source, response: settled.result.value });
    const usage = settled.result.value.usage;
    state.usage.promptTokens += usage.promptTokens;
    state.usage.cachedPromptTokens += usage.cachedPromptTokens;
    state.usage.completionTokens += usage.completionTokens;
    state.usage.totalTokens += usage.totalTokens;
    return;
  }
  const error = settled.result.error;
  if (isRunCancellation(state, error)) {
    markCancelled(report, cancellationNote(state));
    logger?.debug('Peer cancelled during quorum', {
      source: settled.source.name,
      status: report.status,
      error: error.message,
    });
    return;
  }
  markFailed(report, error);
  logger?.warn('Peer failed during quorum', {
    source: settled.source.name,
    status: report.status,
    error: error.message,
  });
}

/** The run — or the caller through it — ended while peers were still in flight,
 * and the orchestrator unwound before it observed their abort: they carry the
 * same cancelled row as the siblings it did observe, never the seeded
 * "no response recorded" error (one abort, one verdict). Rows a clock already
 * stamped — the tier-budget outage, the wall's straggler — keep their failure
 * shape, so a peer cut off by a clock still reads as degraded: only an untouched
 * (`cause`-less), never-settled report is re-labelled here. */
export function markCancelledStragglers(state: StragglerState): void {
  if (!abortedByRun(state)) {
    return;
  }
  for (const report of state.reports.values()) {
    if (report.status === 'error' && report.cause === undefined && !state.settled.has(report.name)) {
      markCancelled(report, cancellationNote(state));
    }
  }
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
