import { ok, err, type Result } from 'neverthrow';
import type { QuorumResult, QuorumSourceReport } from '../entities/index.js';
import { ExternalServiceError, type DomainError } from '../errors/index.js';
import { AGREEMENT_THRESHOLD, computeCertainty } from './agreement.js';
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
    const agreeingRatings = state.lastEval.ratings
      .filter((r) => r.agreement >= AGREEMENT_THRESHOLD)
      .map((r) => r.agreement);
    return ok({
      response: state.achieved ? state.lastEval.consensus : '',
      ...(state.achieved ? {} : { responseWithheld: true as const }),
      certaintyScore: computeCertainty(state.agreeingWeight, requiredWeight, agreeingRatings),
      ...(input.callerAnswer !== undefined
        ? { callerAgreement: state.lastEval.callerAgreement ?? null }
        : {}),
      ...base,
    });
  }

  const top = [...state.successes].sort((a, b) => b.source.weight - a.source.weight)[0];
  if (top === undefined) {
    return err(new ExternalServiceError('No peer source produced a response', 'peer-review'));
  }
  return ok({
    response: state.achieved ? top.response.text : '',
    ...(state.achieved ? {} : { responseWithheld: true as const }),
    certaintyScore: 0,
    ...(state.arbiterFailed ? { arbiterFailed: true } : {}),
    ...(input.callerAnswer !== undefined ? { callerAgreement: null } : {}),
    ...base,
  });
}
