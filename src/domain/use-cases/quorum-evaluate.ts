import { AGREEMENT_THRESHOLD, evaluateAgreement } from './agreement.js';
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
    return;
  }
  state.arbiterFailed = false;
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
