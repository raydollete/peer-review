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

/**
 * Freeze the in-flight run state into the reference `QuorumResult` envelope.
 *
 * Prose is withheld unless the quorum was achieved: text no quorum validated is
 * unvalidated opinion. Verdict metadata is always returned in full so the result
 * stays honestly transcribable. Any arbiter failure — including a later tier's
 * re-evaluation failing after an earlier tier succeeded — forces the fallback
 * path so a stale consensus never surfaces with a non-zero certainty.
 */
export function assembleResult(
  input: QuorumInput,
  state: RunState,
  tier: number,
  requiredWeight: number,
  peerSources: readonly PeerSource[],
): Result<QuorumResult, DomainError> {
  const sources: QuorumSourceReport[] = [...state.reports.values()].map((report) => ({
    ...report,
  }));
  const base = {
    achieved: state.achieved,
    tier,
    requiredWeight,
    agreeingWeight: state.agreeingWeight,
    sources,
    usage: { ...state.usage },
  };

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

/**
 * The total-outage branch: keep the message existing readers grep for, but stop
 * throwing the roster away. The three states this branch collapses are named
 * apart — every source skipped (a caller/skipLocal configuration fault), every
 * source unavailable (credentials unset: a credential fault), and a real peer
 * outage (sources consulted and failed) — each with its own cause and fix, so a
 * configuration fault is never reported as a network fault.
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
