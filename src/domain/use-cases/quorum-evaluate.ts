import { AGREEMENT_THRESHOLD, evaluateAgreement, type AgreementEvaluation } from './agreement.js';
import { ArbiterMalformedError, TimeoutError, type DomainError } from '../errors/index.js';
import type { ArbiterErrorRecord } from '../entities/index.js';
import { isRunCancellation, markArbiterFailed, markRated, UNRATED_OMITTED } from './source-reports.js';
import type { QuorumDeps, QuorumInput, RunState } from './peer-review-quorum.use-case.js';

/** One arbiter evaluation over every success so far: rates each source, folds
 * the arbiter's usage in, and sets `achieved` once agreeing weight meets the bar.
 * An arbiter failure is recorded on the state, never thrown. */
export async function evaluateRun(
  deps: Pick<QuorumDeps, 'arbiter' | 'logger'>,
  input: QuorumInput,
  state: RunState,
  controllerSignal: AbortSignal,
  arbiterTimeoutMs: number,
  requiredWeight: number,
): Promise<void> {
  const signal = AbortSignal.any([controllerSignal, AbortSignal.timeout(arbiterTimeoutMs)]);
  const evaluation = await evaluateAgreement({
    arbiter: { name: deps.arbiter.name, client: deps.arbiter.client },
    question: input.prompt,
    // Named by the configured source, which keys the roster — not by whatever
    // the adapter echoed — so the arbiter's D<n> maps straight onto a row.
    responses: state.successes.map((s) => ({ ...s.response, source: s.source.name })),
    callerAnswer: input.callerAnswer,
    signal,
    logger: deps.logger,
  });
  if (evaluation.isErr()) {
    // The run (or the caller) ended the arbiter's request: "no evaluation this
    // pass", not an arbiter outage — a failure here would discard a valid earlier
    // lastEval and make runTiers fan out further tiers after the caller left.
    if (isRunCancellation(state, evaluation.error)) {
      deps.logger?.debug('Arbiter evaluation skipped: the run was cancelled', { arbiter: deps.arbiter.name });
      return;
    }
    state.arbiterFailed = true;
    // Preserve the arbiter's DomainError instead of dropping it: the roster
    // gets a row, and the caller can tell an unavailable arbiter from a reply
    // that failed JSON extraction.
    state.arbiterError = arbiterErrorRecord(deps.arbiter.name, evaluation.error);
    // Earlier ratings stay itemized for transparency, but no row may read as
    // the latest verdict: the failed pass is, and it rated nobody.
    for (const success of state.successes) {
      const report = state.reports.get(success.source.name);
      if (report !== undefined) {
        markArbiterFailed(report);
      }
    }
    return;
  }
  state.arbiterFailed = false;
  state.arbiterError = undefined;
  state.lastEval = evaluation.value;
  state.evaluatedCount = state.successes.length;
  state.usage.promptTokens += evaluation.value.usage.promptTokens;
  state.usage.completionTokens += evaluation.value.usage.completionTokens;
  state.usage.totalTokens += evaluation.value.usage.totalTokens;

  state.agreeingWeight = applyRatings(deps, state, evaluation.value.ratings);
  if (state.agreeingWeight >= requiredWeight) {
    state.achieved = true;
  }
}

/** Write one evaluation's verdict onto every success row and return the agreeing
 * weight. A source the arbiter did not rate is unrated with a note and a logged
 * warning — never a silent 0. */
function applyRatings(
  deps: Pick<QuorumDeps, 'arbiter' | 'logger'>,
  state: RunState,
  ratings: AgreementEvaluation['ratings'],
): number {
  let agreeing = 0;
  for (const success of state.successes) {
    const rating = ratings.find((r) => r.name === success.source.name);
    const report = state.reports.get(success.source.name);
    if (report !== undefined) {
      markRated(report, rating, UNRATED_OMITTED);
    }
    if (rating === undefined) {
      deps.logger?.warn('Arbiter returned no rating for a source', {
        source: success.source.name,
        arbiter: deps.arbiter.name,
      });
    } else if (rating.agreement >= AGREEMENT_THRESHOLD) {
      agreeing += success.source.weight;
    }
  }
  return agreeing;
}


/** Build the preserved arbiter failure from typed fields only: the error's
 * class distinguishes a malformed reply from an unavailable arbiter; the
 * detail is a fixed line, never the model's own text. */
function arbiterErrorRecord(name: string, error: DomainError): ArbiterErrorRecord {
  if (error instanceof ArbiterMalformedError) {
    return {
      code: error.code,
      cause: 'arbiter_malformed',
      source: name,
      detail: `arbiter "${name}" reply failed JSON extraction after one re-ask`,
    };
  }
  if (error instanceof TimeoutError) {
    return {
      code: error.code,
      cause: 'arbiter_unavailable',
      source: name,
      detail: `arbiter "${name}" timed out after ${error.timeoutMs}ms`,
    };
  }
  return {
    code: error.code,
    cause: 'arbiter_unavailable',
    source: name,
    detail: `${error.code} from arbiter "${name}"`,
  };
}