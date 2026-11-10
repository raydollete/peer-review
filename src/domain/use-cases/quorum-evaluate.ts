import { AGREEMENT_THRESHOLD, evaluateAgreement } from './agreement.js';
import { ArbiterMalformedError, TimeoutError, type DomainError } from '../errors/index.js';
import type { ArbiterErrorRecord } from '../entities/index.js';
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
    responses: state.successes.map((s) => s.response),
    callerAnswer: input.callerAnswer,
    signal,
    logger: deps.logger,
  });
  if (evaluation.isErr()) {
    state.arbiterFailed = true;
    // Preserve the arbiter's DomainError instead of dropping it: the roster
    // gets a row, and the caller can tell an unavailable arbiter from a reply
    // that failed JSON extraction.
    state.arbiterError = arbiterErrorRecord(deps.arbiter.name, evaluation.error);
    return;
  }
  state.arbiterFailed = false;
  state.arbiterError = undefined;
  state.lastEval = evaluation.value;
  state.evaluatedCount = state.successes.length;
  state.usage.promptTokens += evaluation.value.usage.promptTokens;
  state.usage.completionTokens += evaluation.value.usage.completionTokens;
  state.usage.totalTokens += evaluation.value.usage.totalTokens;

  let agreeing = 0;
  for (const success of state.successes) {
    const rating =
      evaluation.value.ratings.find((r) => r.name === success.source.name)?.agreement ?? 0;
    const report = state.reports.get(success.source.name);
    if (report !== undefined) {
      report.agreement = rating;
    }
    if (rating >= AGREEMENT_THRESHOLD) {
      agreeing += success.source.weight;
    }
  }
  state.agreeingWeight = agreeing;
  if (agreeing >= requiredWeight) {
    state.achieved = true;
  }
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