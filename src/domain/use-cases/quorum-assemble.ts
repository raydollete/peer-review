import { ok, err, type Result } from 'neverthrow';
import type {
  QuorumResult,
  QuorumErrorContext,
  QuorumSourceReport,
} from '../entities/index.js';
import { arbiterReport } from '../entities/index.js';
import {
  QuorumFailureError,
  fixFor,
  type DomainError,
  type PeerReviewFailureCause,
} from '../errors/index.js';
import { AGREEMENT_THRESHOLD, computeCertainty, type AgreementEvaluation } from './agreement.js';
import type { PeerSource } from '../ports/index.js';
import type { QuorumInput, RunState } from './peer-review-quorum.use-case.js';
import { UNRATED_RUN_ENDED } from './source-reports.js';

/**
 * Freeze the in-flight run state into the reference `QuorumResult` envelope.
 *
 * Prose is withheld unless the quorum was achieved: text no quorum validated is
 * unvalidated opinion. Verdict metadata is always returned in full so the result
 * stays honestly transcribable. Any arbiter failure — including a later tier's
 * re-evaluation failing after an earlier tier succeeded — forces the fallback
 * path so a stale consensus never surfaces with a non-zero certainty.
 *
 * One not-achieved shape is a failure rather than a verdict: when the weight the
 * run still needed belongs to a source a clock dropped while it was in flight
 * (see {@link lateQuorumLoss}), that weight was never attainable inside the
 * budget, so the run reports itself unreachable. `deadlineMs` is the run's wall —
 * the number `markDeadlineStragglers` stamps on its stragglers — which is what
 * separates the wall's rows from a peer that exceeded its own `timeoutMs`.
 */
export function assembleResult(
  input: QuorumInput,
  state: RunState,
  tier: number,
  requiredWeight: number,
  peerSources: readonly PeerSource[],
  deadlineMs: number,
): Result<QuorumResult, DomainError> {
  // An ok row no completed evaluation rated (deadline mid-evaluation, or a peer
  // that answered during the deciding one) still says why it has no rating.
  const sources: QuorumSourceReport[] = [...state.reports.values()].map((report) =>
    report.status === 'ok' && report.agreement === null && report.note === undefined
      ? { ...report, note: UNRATED_RUN_ENDED }
      : { ...report },
  );
  const base = {
    achieved: state.achieved,
    tier,
    requiredWeight,
    agreeingWeight: state.agreeingWeight,
    sources,
    usage: { ...state.usage },
  };

  // Weight lost to lateness is an unreachable quorum, not a low-certainty
  // verdict: report it as a failure so the caller repairs the budget instead of
  // reading a quiet shortfall. Keyed on lateness alone — a shortfall owned by a
  // rate-limited, credential- or transport-failed peer, and a run whose
  // attainable weight simply was not agreed, keep the envelopes below.
  const unreachable = lateQuorumFailure(state, sources, tier, requiredWeight, deadlineMs);
  if (unreachable !== undefined) {
    return err(unreachable);
  }

  if (state.lastEval !== undefined && !state.arbiterFailed) {
    return lastEvalResult(input, state.lastEval, state.achieved, state.agreeingWeight, base);
  }

  const top = [...state.successes].sort((a, b) => b.source.weight - a.source.weight)[0];
  if (top === undefined) {
    const context: QuorumErrorContext = {
      tier,
      requiredWeight,
      agreeingWeight: state.agreeingWeight,
      ...(state.arbiterError !== undefined ? { arbiter: arbiterReport(state.arbiterError) } : {}),
      sources,
    };
    return err(noResponseError(sources, context, peerSources));
  }
  return ok({
    response: state.achieved ? top.response.text : '',
    ...(state.achieved ? {} : { responseWithheld: true as const }),
    certaintyScore: 0,
    ...(state.arbiterFailed ? { arbiterFailed: true } : {}),
    // The preserved arbiter failure rides the success path as a roster row —
    // never a bare boolean (quorum-orchestration spec).
    ...(state.arbiterError !== undefined ? { arbiter: arbiterReport(state.arbiterError) } : {}),
    ...(input.callerAnswer !== undefined ? { callerAgreement: null } : {}),
    ...base,
  });
}

/** Whether this roster row was dropped for lateness: a clock took it while it
 * was still in flight. `cause: 'deadline'` alone fuses three clocks
 * (`TimeoutError`, `CancellationError` and `TierBudgetElapsedError` all map to
 * it), so the budget stamped on the row discriminates — absent means the tier's
 * slice expired (`markPendingOutage` stamps none), equal to the run's wall means
 * the outer wall's straggler (`markDeadlineStragglers` stamps the wall's
 * number). A row stamped with any other `timeoutMs` exceeded its OWN budget, and
 * the wall is not its repair: it keeps today's envelope. */
function isLateDrop(report: QuorumSourceReport, deadlineMs: number): boolean {
  return (
    report.status === 'error' &&
    report.cause === 'deadline' &&
    (report.timeoutMs === undefined || report.timeoutMs === deadlineMs)
  );
}

/** The unreachable-quorum report of a run that lost the weight it still needed
 * to a clock, or `undefined` when its miss is not one lateness caused. Present
 * only when the run answered at least one source, the arbiter did not fail, the
 * settled weight sits below `requiredWeight`, and a consulted row is late by
 * {@link isLateDrop}. The top-level source is the heaviest late row (ties keep
 * roster order, the tie-break `leadFailure` applies); the detail states the
 * settled weight against the required one and names every late source; the fix
 * names the wall that has to grow, or the output budget that has to shrink; the
 * roster rides in `context` so the caller still sees each row's own cause. */
function lateQuorumFailure(
  state: RunState,
  sources: readonly QuorumSourceReport[],
  tier: number,
  requiredWeight: number,
  deadlineMs: number,
): QuorumFailureError | undefined {
  if (state.achieved || state.arbiterFailed || state.successes.length === 0) {
    return undefined;
  }
  const settledWeight = state.successes.reduce((sum, success) => sum + success.source.weight, 0);
  if (settledWeight >= requiredWeight) {
    return undefined;
  }
  const late = sources.filter((report) => isLateDrop(report, deadlineMs));
  if (late.length === 0) {
    return undefined;
  }
  const lead = late.reduce((heaviest, report) =>
    report.weight > heaviest.weight ? report : heaviest,
  );
  const names = late.map((report) => report.name).join(', ');
  const context: QuorumErrorContext = {
    tier,
    requiredWeight,
    agreeingWeight: state.agreeingWeight,
    sources,
  };
  return new QuorumFailureError(
    'Quorum unreachable: a source was dropped for lateness',
    'peer-review',
    {
      cause: 'deadline',
      source: lead.name,
      detail: `Settled weight ${settledWeight} of the ${requiredWeight} required; dropped for lateness: ${names} — see error.context.sources[]`,
      fix: `Raise the review deadline saved in the app (runtime.deadlineMs, rendered as PEER_REVIEW_DEADLINE_MS) so each tier's slice covers its slowest source at its output budget, or lower ${lead.name}'s maxOutputTokens/timeoutMs`,
      context,
    },
  );
}

/**
 * The total-outage branch: keep the message existing readers grep for, but stop
 * throwing the roster away. The four states this branch collapses are named
 * apart — every source skipped (a caller/skipLocal configuration fault), every
 * source unavailable (credentials unset: a credential fault), every source
 * cancelled (the run or the caller ended first: nothing failed), and a real peer
 * outage (sources consulted and failed) — each with its own cause and fix, so a
 * configuration fault is never reported as a network fault and a run cancellation
 * is never reported as a peer defect.
 */
function noResponseError(
  consulted: readonly QuorumSourceReport[],
  context: QuorumErrorContext,
  peerSources: readonly PeerSource[],
): QuorumFailureError {
  const message = 'No peer source produced a response';
  const detail =
    'No consulted peer source produced a usable response; see error.context.sources[]';
  if (consulted.length > 0 && consulted.every((s) => s.status === 'skipped')) {
    return new QuorumFailureError(message, 'peer-review', {
      cause: 'configuration',
      detail,
      fix: 'Every consulted source was skipped as redundant: unset the wrong callerSource or PEER_REVIEW_SKIP_LOCAL, or add sources to peer-review.config.json',
      context,
    });
  }
  if (consulted.length > 0 && consulted.every((s) => s.status === 'unavailable')) {
    return new QuorumFailureError(message, 'peer-review', {
      cause: 'credential',
      detail,
      fix: 'Set the credential env vars or repair apiKeyCommand for the unavailable sources in peer-review.config.json, then restart the server',
      context,
    });
  }
  if (consulted.length > 0 && consulted.every((s) => s.status === 'cancelled')) {
    // Nothing failed — the run walked away from every consulted source before any
    // of them answered. leadFailure filters cancelled rows out, so falling through
    // would call this 'internal' and point at a correlationId the context never
    // carries. The cause plus the fix name the run as the author.
    return new QuorumFailureError(message, 'peer-review', {
      cause: 'cancelled',
      detail,
      fix: fixFor('cancelled'),
      context,
    });
  }
  const lead = leadFailure(consulted, peerSources);
  return new QuorumFailureError(message, 'peer-review', {
    cause: lead?.cause ?? 'internal',
    ...(lead !== undefined ? { source: lead.source } : {}),
    detail,
    fix: lead !== undefined ? fixFor(lead.cause) : fixFor('internal'),
    context,
  });
}

/** Top-level cause of a multi-source failure: the cause of the highest-weight
 * failed source; ties break to the lower tier, then config order. Every roster
 * entry keeps its own cause. */
function leadFailure(
  consulted: readonly QuorumSourceReport[],
  peerSources: readonly PeerSource[],
): { cause: PeerReviewFailureCause; source: string } | undefined {
  const meta = new Map(peerSources.map((s, i) => [s.name, { tier: s.tier, index: i }]));
  const failed = consulted.filter((s) => s.status === 'error' || s.status === 'unavailable');
  const lead = failed.sort(
    (a, b) =>
      b.weight - a.weight ||
      (meta.get(a.name)?.tier ?? 0) - (meta.get(b.name)?.tier ?? 0) ||
      (meta.get(a.name)?.index ?? Number.MAX_SAFE_INTEGER) -
        (meta.get(b.name)?.index ?? Number.MAX_SAFE_INTEGER),
  )[0];
  if (lead === undefined || lead.cause === undefined) {
    return undefined;
  }
  return { cause: lead.cause, source: lead.name };
}

type QuorumBase = Omit<
  QuorumResult,
  'response' | 'certaintyScore' | 'callerAgreement' | 'responseWithheld'
>;

function lastEvalResult(
  input: QuorumInput,
  evaluation: AgreementEvaluation,
  achieving: boolean,
  agreeingWeight: number,
  base: QuorumBase,
): Result<QuorumResult, DomainError> {
  const agreeingRatings = evaluation.ratings
    .filter((r) => r.agreement >= AGREEMENT_THRESHOLD)
    .map((r) => r.agreement);
  return ok({
    response: achieving ? evaluation.consensus : '',
    ...(achieving ? {} : { responseWithheld: true as const }),
    certaintyScore: computeCertainty(agreeingWeight, base.requiredWeight, agreeingRatings),
    ...(input.callerAnswer !== undefined
      ? { callerAgreement: evaluation.callerAgreement ?? null }
      : {}),
    ...base,
  });
}
