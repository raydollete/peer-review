import { err, type Result } from 'neverthrow';
import type { HistoryTurn, PeerResponse, QuorumResult } from '../entities/index.js';
import type { PeerSource } from '../ports/index.js';
import { ConfigurationError, ExternalServiceError, ValidationError } from '../errors/index.js';
import type { DomainError } from '../errors/index.js';
import { AGREEMENT_THRESHOLD, evaluateAgreement } from './agreement.js';
import type { AgreementEvaluation } from './agreement.js';
import { markFailed, markOk, markSkipped, seedReport } from './source-reports.js';
import type { MutableReport } from './source-reports.js';
import { computeTierBudget, markPendingOutage, signalAbortPromise } from './tier-budget.js';
import { assembleResult } from './quorum-assemble.js';
import type { ILogger } from '../../shared/logger/index.js';

export interface QuorumInput {
  readonly prompt: string;
  readonly history?: readonly HistoryTurn[] | undefined;
  readonly tier?: number | undefined;
  /** The calling agent's own answer — arbiter-rated only, never sent to peers. */
  readonly callerAnswer?: string | undefined;
  /** A configured source the caller itself is — skipped as a redundant peer for
   * this request (never called; itemized as `status: 'skipped'`). Unknown name =
   * logged no-op. Independent of `callerAnswer`. */
  readonly callerSource?: string | undefined;
}

export interface QuorumDeps {
  readonly sources: readonly PeerSource[];
  readonly arbiter: PeerSource;
  readonly thresholds: Readonly<Record<number, number>>;
  readonly deadlineMs: number;
  /** The arbiter's effective request timeout, reserved out of each tier's budget
   * so an evaluation always fits before the outer wall. Defaults to 0 (no
   * reserve) when unset — production wires the arbiter source's real timeout. */
  readonly arbiterTimeoutMs?: number | undefined;
  /** When true, every source flagged `local` is excluded from the quorum for the
   * request — the class-wide sibling of a per-request `callerSource` skip. Set
   * per-harness via PEER_REVIEW_SKIP_LOCAL when the caller runs on the local
   * backend, so it does not contend with itself. */
  readonly skipLocal?: boolean | undefined;
  readonly logger?: Pick<ILogger, 'warn'> | undefined;
}

export interface RunState {
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

    // A3: an unknown callerSource is a logged no-op, never a crash — the caller
    // may be pointed at a differently-configured server than it assumes.
    if (
      input.callerSource !== undefined &&
      !this.deps.sources.some((s) => s.name === input.callerSource)
    ) {
      this.deps.logger?.warn('callerSource names no configured source; ignoring', {
        callerSource: input.callerSource,
      });
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
    const start = Date.now();
    const timer = setTimeout(() => {
      state.deadlineHit = true;
      controller.abort();
    }, this.deps.deadlineMs);

    let reachedTier = targetTier;
    try {
      reachedTier = await this.runTiers(tiers, targetTier, requiredWeight, input, state, controller, start);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return assembleResult(input, state, reachedTier, requiredWeight);
  }

  /**
   * Walk the tiers in order. `tier` selects review depth and cost — it is NOT a
   * failover barrier. requiredWeight is HELD at the requested tier's threshold
   * throughout: escalation restores the capacity to reach the caller's bar, it
   * never raises that bar (see design.md § "Review Feedback" point 2).
   */
  private async runTiers(
    tiers: readonly number[],
    targetTier: number,
    requiredWeight: number,
    input: QuorumInput,
    state: RunState,
    controller: AbortController,
    start: number,
  ): Promise<number> {
    let reachedTier = targetTier;
    for (const tier of tiers) {
      // Hold the ceiling on a DISAGREEMENT-shaped miss (everyone answered,
      // attainable weight already meets the bar — revisable, no escalation).
      // But an arbiter that could not render a verdict (arbiterFailed) is a
      // recoverable outage, not disagreement: permit escalation to a fresh
      // arbiter attempt at the next tier instead of breaking here (C1).
      if (
        tier > targetTier &&
        this.attainableWeight(state) >= requiredWeight &&
        !(state.arbiterFailed && !state.achieved)
      ) {
        break;
      }
      reachedTier = tier;
      const tiersRemaining = tiers.length - tiers.indexOf(tier);
      const tierBudget = computeTierBudget(
        this.deps.deadlineMs,
        Date.now() - start,
        tiersRemaining,
        this.deps.arbiterTimeoutMs ?? 0,
      );
      const tierSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(tierBudget)]);
      await this.runTier(tier, input, state, controller, requiredWeight, tierSignal);
      if (state.achieved || state.deadlineHit) {
        break;
      }
    }
    return reachedTier;
  }

  private launchTier(
    tier: number,
    input: QuorumInput,
    state: RunState,
    signal: AbortSignal,
  ): {
    pending: Map<number, Promise<{ key: number; settled: Settled }>>;
    inflight: Map<number, PeerSource>;
  } {
    const pending = new Map<number, Promise<{ key: number; settled: Settled }>>();
    const inflight = new Map<number, PeerSource>();
    let nextKey = 0;
    for (const source of this.deps.sources.filter((s) => s.tier === tier)) {
      const report = seedReport(source);
      state.reports.set(source.name, report);
      // Excluded for this request — skip it as a redundant peer (never launch),
      // mirroring the `!source.available` skip but with a distinct, transparent
      // status so the exclusion shows in `sources[]`. Two independent triggers,
      // applied as a union: the caller declared it IS this source
      // (`callerSource`), or the caller is local and this source is local
      // (`skipLocal`). Either alone suffices.
      if (source.name === input.callerSource || (this.deps.skipLocal === true && source.local === true)) {
        markSkipped(report);
        continue;
      }
      if (!source.available) {
        continue;
      }
      const key = nextKey;
      nextKey += 1;
      inflight.set(key, source);
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
    return { pending, inflight };
  }

  private async runTier(
    tier: number,
    input: QuorumInput,
    state: RunState,
    controller: AbortController,
    requiredWeight: number,
    tierSignal: AbortSignal,
  ): Promise<void> {
    const { pending, inflight } = this.launchTier(tier, input, state, tierSignal);

    // Resolves when the tier signal aborts — either the global wall (terminal)
    // or this tier's own budget elapsing (non-terminal → escalate). One listener
    // for the whole tier; the runtime owns its cleanup.
    const tierAborted = Symbol('tier-signal-aborted');
    const abortRace = signalAbortPromise(tierSignal, tierAborted);

    while (pending.size > 0) {
      const winner = await Promise.race<{ key: number; settled: Settled } | typeof tierAborted>([
        ...pending.values(),
        abortRace,
      ]);
      if (winner === tierAborted) {
        // Global wall hit → terminal: leave stragglers on their seeded "no
        // response recorded" report, exactly as before. Tier budget hit (global
        // NOT hit) → mark the still-in-flight sources outage-shaped so their
        // weight is unattainable within budget, then return to escalate.
        if (!state.deadlineHit) {
          markPendingOutage(inflight, state.reports);
        }
        return;
      }
      pending.delete(winner.key);
      inflight.delete(winner.key);
      this.record(state, winner.settled);
      // Consume every already-settled peer before evaluating, so a same-tick
      // sibling response is never discarded by an early-abort.
      await this.drainSettled(pending, inflight, state);
      if (state.deadlineHit) {
        return;
      }
      if (!state.achieved && pending.size > 0 && this.quorumPossible(state, requiredWeight)) {
        await this.evaluate(input, state, tierSignal, requiredWeight);
        if (state.achieved) {
          // Early-abort: quorum met, cancel remaining in-flight peers to save cost.
          controller.abort();
          return;
        }
      }
    }

    if (!state.achieved && !state.deadlineHit && state.successes.length > state.evaluatedCount) {
      await this.evaluate(input, state, tierSignal, requiredWeight);
    }
  }

  private async drainSettled(
    pending: Map<number, Promise<{ key: number; settled: Settled }>>,
    inflight: Map<number, PeerSource>,
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
      inflight.delete(winner.key);
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
      markOk(report);
      state.successes.push({ source: settled.source, response: settled.result.value });
      const usage = settled.result.value.usage;
      state.usage.promptTokens += usage.promptTokens;
      state.usage.completionTokens += usage.completionTokens;
      state.usage.totalTokens += usage.totalTokens;
    } else {
      markFailed(report, settled.result.error);
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
}
