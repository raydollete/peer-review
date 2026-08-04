import { ok, err, type Result } from 'neverthrow';
import type {
  HistoryTurn,
  PeerResponse,
  QuorumResult,
  QuorumSourceReport,
} from '../entities/index.js';
import type { PeerSource } from '../ports/index.js';
import {
  ConfigurationError,
  ExternalServiceError,
  ValidationError,
  type DomainError,
} from '../errors/index.js';
import {
  AGREEMENT_THRESHOLD,
  computeCertainty,
  evaluateAgreement,
  type AgreementEvaluation,
} from './agreement.js';
import type { ILogger } from '../../shared/logger/index.js';

export interface QuorumInput {
  readonly prompt: string;
  readonly history?: readonly HistoryTurn[] | undefined;
  readonly tier?: number | undefined;
  /** The calling agent's own answer — arbiter-rated only, never sent to peers. */
  readonly callerAnswer?: string | undefined;
}

export interface QuorumDeps {
  readonly sources: readonly PeerSource[];
  readonly arbiter: PeerSource;
  readonly thresholds: Readonly<Record<number, number>>;
  readonly deadlineMs: number;
  readonly logger?: Pick<ILogger, 'warn'> | undefined;
}

interface MutableReport {
  name: string;
  model: string;
  status: 'ok' | 'error' | 'unavailable';
  weight: number;
  agreement: number | null;
}

interface RunState {
  readonly reports: Map<string, MutableReport>;
  readonly successes: Array<{ source: PeerSource; response: PeerResponse }>;
  readonly usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  lastEval: AgreementEvaluation | undefined;
  agreeingWeight: number;
  achieved: boolean;
  arbiterFailed: boolean;
  evaluatedCount: number;
  deadlineHit: boolean;
}

interface Settled {
  readonly source: PeerSource;
  readonly result: Result<PeerResponse, DomainError>;
}

export class PeerReviewQuorumUseCase {
  constructor(private readonly deps: QuorumDeps) {}

  async execute(input: QuorumInput): Promise<Result<QuorumResult, DomainError>> {
    const tiers = [...new Set(this.deps.sources.map((s) => s.tier))].sort((a, b) => a - b);
    const maxTier = tiers[tiers.length - 1];
    if (maxTier === undefined) {
      return err(new ConfigurationError('No peer sources configured'));
    }
    const targetTier = input.tier ?? maxTier;
    const requiredWeight = this.deps.thresholds[targetTier];
    if (requiredWeight === undefined) {
      return err(new ValidationError(`No threshold configured for tier ${targetTier}`));
    }

    const state: RunState = {
      reports: new Map(),
      successes: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      lastEval: undefined,
      agreeingWeight: 0,
      achieved: false,
      arbiterFailed: false,
      evaluatedCount: 0,
      deadlineHit: false,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      state.deadlineHit = true;
      controller.abort();
    }, this.deps.deadlineMs);

    let reachedTier = targetTier;
    try {
      // `tier` selects review depth and cost — it is NOT a failover barrier. A
      // miss is outage-shaped (attainable < required: missing weight belongs to
      // an errored source, so no re-evaluation can clear it) and escalates past
      // the ceiling to restore capacity; or disagreement-shaped (everyone
      // answered, they disagreed), which is revisable and holds the ceiling.
      // requiredWeight is HELD at the requested tier's threshold throughout —
      // escalation restores the capacity to reach the caller's bar, it never
      // raises that bar. See design.md § "Review Feedback" point 2.
      for (const tier of tiers) {
        if (tier > targetTier && this.attainableWeight(state) >= requiredWeight) {
          break;
        }
        reachedTier = tier;
        await this.runTier(tier, input, state, controller, requiredWeight);
        if (state.achieved || state.deadlineHit) {
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return this.assemble(input, state, reachedTier, requiredWeight);
  }

  private launchTier(
    tier: number,
    input: QuorumInput,
    state: RunState,
    signal: AbortSignal,
  ): Map<number, Promise<{ key: number; settled: Settled }>> {
    const pending = new Map<number, Promise<{ key: number; settled: Settled }>>();
    let nextKey = 0;
    for (const source of this.deps.sources.filter((s) => s.tier === tier)) {
      const report: MutableReport = {
        name: source.name,
        model: source.model,
        status: source.available ? 'error' : 'unavailable',
        weight: source.weight,
        agreement: null,
      };
      state.reports.set(source.name, report);
      if (!source.available) {
        continue;
      }
      const key = nextKey;
      nextKey += 1;
      pending.set(
        key,
        source.client
          .complete({ prompt: input.prompt, history: input.history, signal })
          .catch((error: unknown) =>
            err<PeerResponse, DomainError>(new ExternalServiceError(String(error), source.name)),
          )
          .then((result) => ({ key, settled: { source, result } })),
      );
    }
    return pending;
  }

  private async runTier(
    tier: number,
    input: QuorumInput,
    state: RunState,
    controller: AbortController,
    requiredWeight: number,
  ): Promise<void> {
    const pending = this.launchTier(tier, input, state, controller.signal);

    while (pending.size > 0) {
      const { key, settled } = await Promise.race(pending.values());
      pending.delete(key);
      this.record(state, settled);
      // Consume every already-settled peer before evaluating, so a same-tick
      // sibling response is never discarded by an early-abort.
      await this.drainSettled(pending, state);
      if (state.deadlineHit) {
        return;
      }
      if (!state.achieved && pending.size > 0 && this.quorumPossible(state, requiredWeight)) {
        await this.evaluate(input, state, controller.signal, requiredWeight);
        if (state.achieved) {
          // Early-abort: quorum met, cancel remaining in-flight peers to save cost.
          controller.abort();
          return;
        }
      }
    }

    if (!state.achieved && !state.deadlineHit && state.successes.length > state.evaluatedCount) {
      await this.evaluate(input, state, controller.signal, requiredWeight);
    }
  }

  private async drainSettled(
    pending: Map<number, Promise<{ key: number; settled: Settled }>>,
    state: RunState,
  ): Promise<void> {
    const sentinel = Symbol('no-settled-result');
    while (pending.size > 0) {
      const winner = await Promise.race<{ key: number; settled: Settled } | typeof sentinel>([
        ...pending.values(),
        Promise.resolve(sentinel),
      ]);
      if (winner === sentinel) {
        return;
      }
      pending.delete(winner.key);
      this.record(state, winner.settled);
    }
  }

  /**
   * Summed weight of sources that have SETTLED successfully.
   *
   * Counts only settled successes — never pending or in-flight sources — so a
   * slow peer is not mistaken for a dead one. Below requiredWeight between tiers
   * means the miss is an outage (escalate); at or above it means disagreement.
   */
  private attainableWeight(state: RunState): number {
    return state.successes.reduce((sum, s) => sum + s.source.weight, 0);
  }

  private quorumPossible(state: RunState, requiredWeight: number): boolean {
    if (state.successes.length <= state.evaluatedCount) {
      return false;
    }
    return this.attainableWeight(state) >= requiredWeight;
  }

  private record(state: RunState, settled: Settled): void {
    const report = state.reports.get(settled.source.name);
    if (report === undefined) {
      return;
    }
    if (settled.result.isOk()) {
      report.status = 'ok';
      state.successes.push({ source: settled.source, response: settled.result.value });
      const usage = settled.result.value.usage;
      state.usage.promptTokens += usage.promptTokens;
      state.usage.completionTokens += usage.completionTokens;
      state.usage.totalTokens += usage.totalTokens;
    } else {
      report.status =
        settled.result.error instanceof ConfigurationError ? 'unavailable' : 'error';
      this.deps.logger?.warn('Peer failed during quorum', {
        source: settled.source.name,
        status: report.status,
        error: settled.result.error.message,
      });
    }
  }

  private async evaluate(
    input: QuorumInput,
    state: RunState,
    signal: AbortSignal,
    requiredWeight: number,
  ): Promise<void> {
    const evaluation = await evaluateAgreement({
      arbiter: { name: this.deps.arbiter.name, client: this.deps.arbiter.client },
      question: input.prompt,
      responses: state.successes.map((s) => s.response),
      callerAnswer: input.callerAnswer,
      signal,
      logger: this.deps.logger,
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

  private assemble(
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

    // D7: any arbiter failure — including a later tier's re-evaluation failing
    // after an earlier tier's eval succeeded — forces the fallback path below.
    // A stale consensus must never surface with a non-zero certainty.
    if (state.lastEval !== undefined && !state.arbiterFailed) {
      const agreeingRatings = state.lastEval.ratings
        .filter((r) => r.agreement >= AGREEMENT_THRESHOLD)
        .map((r) => r.agreement);
      return ok({
        // Withhold prose no quorum validated. `response` stays a string ('') so
        // clients reading it unconditionally are unaffected; the metadata below
        // is returned in full so the verdict is still honestly transcribable.
        response: state.achieved ? state.lastEval.consensus : '',
        ...(state.achieved ? {} : { responseWithheld: true as const }),
        certaintyScore: computeCertainty(state.agreeingWeight, requiredWeight, agreeingRatings),
        // Last evaluation's caller rating wins across tier re-evaluations.
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
      // Same withholding on the fallback path: an unachieved quorum must not hand
      // back a single peer's raw text either — that is prose no quorum validated.
      response: state.achieved ? top.response.text : '',
      ...(state.achieved ? {} : { responseWithheld: true as const }),
      certaintyScore: 0,
      ...(state.arbiterFailed ? { arbiterFailed: true } : {}),
      // No trusted evaluation on this path — a supplied caller answer is unrated.
      ...(input.callerAnswer !== undefined ? { callerAgreement: null } : {}),
      ...base,
    });
  }
}
