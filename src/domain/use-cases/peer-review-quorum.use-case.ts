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

export interface QuorumInput {
  readonly prompt: string;
  readonly history?: readonly HistoryTurn[] | undefined;
  readonly tier?: number | undefined;
}

export interface QuorumDeps {
  readonly sources: readonly PeerSource[];
  readonly arbiter: PeerSource;
  readonly thresholds: Readonly<Record<number, number>>;
  readonly deadlineMs: number;
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
      for (const tier of tiers.filter((t) => t <= targetTier)) {
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
    return this.assemble(state, reachedTier, requiredWeight);
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
        await this.evaluate(input.prompt, state, controller.signal, requiredWeight);
        if (state.achieved) {
          // Early-abort: quorum met, cancel remaining in-flight peers to save cost.
          controller.abort();
          return;
        }
      }
    }

    if (!state.achieved && !state.deadlineHit && state.successes.length > state.evaluatedCount) {
      await this.evaluate(input.prompt, state, controller.signal, requiredWeight);
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

  private quorumPossible(state: RunState, requiredWeight: number): boolean {
    if (state.successes.length <= state.evaluatedCount) {
      return false;
    }
    const potential = state.successes.reduce((sum, s) => sum + s.source.weight, 0);
    return potential >= requiredWeight;
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
    }
  }

  private async evaluate(
    question: string,
    state: RunState,
    signal: AbortSignal,
    requiredWeight: number,
  ): Promise<void> {
    const evaluation = await evaluateAgreement({
      arbiter: { name: this.deps.arbiter.name, client: this.deps.arbiter.client },
      question,
      responses: state.successes.map((s) => s.response),
      signal,
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
        response: state.lastEval.consensus,
        certaintyScore: computeCertainty(state.agreeingWeight, requiredWeight, agreeingRatings),
        ...base,
      });
    }

    const top = [...state.successes].sort((a, b) => b.source.weight - a.source.weight)[0];
    if (top === undefined) {
      return err(new ExternalServiceError('No peer source produced a response', 'peer-review'));
    }
    return ok({
      response: top.response.text,
      certaintyScore: 0,
      ...(state.arbiterFailed ? { arbiterFailed: true } : {}),
      ...base,
    });
  }
}
