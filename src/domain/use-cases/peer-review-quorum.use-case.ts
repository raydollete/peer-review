import { err, type Result } from 'neverthrow';
import type { HistoryTurn, PeerResponse, QuorumResult, ArbiterErrorRecord } from '../entities/index.js';
import type { PeerSource } from '../ports/index.js';
import { ConfigurationError, ExternalServiceError, ValidationError } from '../errors/index.js';
import type { DomainError } from '../errors/index.js';
import type { AgreementEvaluation } from './agreement.js';
import { attachCallerAbort, markDeadlineStragglers, markFailed, markOk, markSkipped, markTierSkippedForTime, noteUnknownCallerSource, seedReport } from './source-reports.js';
import type { MutableReport } from './source-reports.js';
import {
  computeTierBudget,
  markPendingCancelled,
  markPendingOutage,
  MIN_TIER_BUDGET_MS,
  signalAbortPromise,
} from './tier-budget.js';
import { assembleResult } from './quorum-assemble.js';
import { evaluateRun } from './quorum-evaluate.js';
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
  /** Applied to each evaluation independently; test-only callers default it to
   * the current tier budget. */
  readonly arbiterTimeoutMs?: number | undefined;
  /** Production peer-wave allowances; tests may retain the generic fair share. */
  readonly tierTimeoutMs?: Readonly<Record<number, number>> | undefined;
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
  /** Preserved arbiter failure (typed cause + redacted detail); set where
   * arbiterFailed is set, cleared where it is cleared. */
  arbiterError?: ArbiterErrorRecord | undefined;
  /** Names of sources that settled with any outcome — a never-settled report is
   * the run's own straggler, not a peer that failed. */
  settled: Set<string>;
  evaluatedCount: number;
  deadlineHit: boolean;
  /** Highest tier launched so far — read at the wall too, before the run returns. */
  reachedTier: number;
}
interface Settled {
  readonly source: PeerSource;
  readonly result: Result<PeerResponse, DomainError>;
}

export class PeerReviewQuorumUseCase {
  constructor(private readonly deps: QuorumDeps) {}

  async execute(input: QuorumInput, callerSignal?: AbortSignal): Promise<Result<QuorumResult, DomainError>> {
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

    noteUnknownCallerSource(input, this.deps.sources, this.deps.logger);

    const state: RunState = {
      reports: new Map(),
      successes: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      lastEval: undefined,
      agreeingWeight: 0,
      achieved: false,
      arbiterFailed: false,
      settled: new Set<string>(),
      evaluatedCount: 0,
      deadlineHit: false,
      reachedTier: targetTier,
    };
    const controller = new AbortController();
    const detachCallerAbort = attachCallerAbort(controller, callerSignal);
    const start = Date.now();
    const timer = setTimeout(() => {
      state.deadlineHit = true;
      controller.abort();
    }, this.deps.deadlineMs);
    // Preemptive wall: the controller aborts only at the deadline or on an
    // early-abort (after which the run just unwinds), so the reply returns from
    // the accumulated state even when an await inside the run ignores the abort.
    const wall = signalAbortPromise(controller.signal, undefined);

    try {
      await Promise.race([
        this.runTiers(tiers, targetTier, requiredWeight, input, state, controller, start),
        wall,
      ]);
    } finally {
      clearTimeout(timer);
      detachCallerAbort();
      controller.abort();
    }
    markDeadlineStragglers(state, this.deps.deadlineMs);
    return assembleResult(input, state, state.reachedTier, requiredWeight, this.deps.sources);
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
  ): Promise<void> {
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
      const tiersRemaining = tiers.length - tiers.indexOf(tier);
      const elapsedMs = Date.now() - start;
      const fallbackTierBudget = computeTierBudget(
        this.deps.deadlineMs, elapsedMs, tiersRemaining, 0,
      );
      // Every wave ends in time for one arbiter evaluation before the wall. The
      // test-only fallback reserves nothing, as its tier budget already does.
      const remainingBudget = computeTierBudget(
        this.deps.deadlineMs, elapsedMs, 1, this.deps.arbiterTimeoutMs ?? 0,
      );
      if (remainingBudget === MIN_TIER_BUDGET_MS) {
        // No time left: send nothing (a request may be billed) and itemize the
        // tier as skipped rather than misreport healthy sources as outages.
        markTierSkippedForTime(this.deps.sources.filter((s) => s.tier === tier), state.reports);
        break;
      }
      state.reachedTier = tier;
      const peerTimeoutMs = Math.min(
        this.deps.tierTimeoutMs?.[tier] ?? fallbackTierBudget, remainingBudget,
      );
      const arbiterTimeoutMs = this.deps.arbiterTimeoutMs ?? fallbackTierBudget;
      const peerSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(peerTimeoutMs)]);
      await this.runTier(tier, input, state, controller, requiredWeight, peerSignal, arbiterTimeoutMs);
      if (state.achieved || state.deadlineHit) {
        break;
      }
    }
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
    peerSignal: AbortSignal,
    arbiterTimeoutMs: number,
  ): Promise<void> {
    const { pending, inflight } = this.launchTier(tier, input, state, peerSignal);

    // Resolves when the tier signal aborts — either the global wall (terminal)
    // or this tier's own budget elapsing (non-terminal → escalate). One listener
    // for the whole tier; the runtime owns its cleanup.
    const tierAborted = Symbol('tier-signal-aborted');
    const abortRace = signalAbortPromise(peerSignal, tierAborted);

    while (pending.size > 0) {
      // abortRace goes FIRST: when the signal already fired (e.g. during
      // `evaluate`), the pending peers have settled with their own cancellation
      // errors too, and race order makes the abort win rather than recording
      // those as peer failures.
      const winner = await Promise.race<{ key: number; settled: Settled } | typeof tierAborted>([
        abortRace,
        ...pending.values(),
      ]);
      if (winner === tierAborted) {
        // Global wall hit → terminal: leave stragglers on their seeded "no
        // response recorded" report, exactly as before. Tier budget hit (global
        // NOT hit) → mark the still-in-flight sources outage-shaped so their
        // weight is unattainable within budget, then return to escalate.
        if (state.deadlineHit) {
          return;
        }
        const kept = await this.keepSettledAnswers(pending, inflight, state);
        markPendingOutage(inflight, state.reports);
        if (kept && this.quorumPossible(state, requiredWeight)) {
          await evaluateRun(this.deps, input, state, controller.signal, arbiterTimeoutMs, requiredWeight);
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
        await evaluateRun(this.deps, input, state, controller.signal, arbiterTimeoutMs, requiredWeight);
        if (state.achieved) {
          // Early-abort: quorum met, cancel remaining in-flight peers to save cost.
          // Record peers that answered during evaluation first — unless the peer
          // signal fired meanwhile, so what settled is its own cancellation. The
          // rest were not needed, not failed: they are itemized as cancelled.
          await this.drainSettled(pending, inflight, state, peerSignal);
          markPendingCancelled(inflight, state.reports);
          controller.abort();
          return;
        }
      }
    }

    if (!state.achieved && !state.deadlineHit && state.successes.length > state.evaluatedCount) {
      await evaluateRun(this.deps, input, state, controller.signal, arbiterTimeoutMs, requiredWeight);
    }
  }

  /** A tier slice ended while an evaluation outlasted it: keep every peer that
   * already answered — only an ok() result is an answer; a settled error is the
   * abort's own. Returns whether any answer was kept. */
  private async keepSettledAnswers(
    pending: Map<number, Promise<{ key: number; settled: Settled }>>,
    inflight: Map<number, PeerSource>,
    state: RunState,
  ): Promise<boolean> {
    const sentinel = Symbol('not-settled');
    let kept = false;
    for (const [key, promise] of pending) {
      const winner = await Promise.race([promise, Promise.resolve(sentinel)]);
      if (winner !== sentinel && winner.settled.result.isOk()) {
        pending.delete(key);
        inflight.delete(key);
        this.record(state, winner.settled);
        kept = true;
      }
    }
    return kept;
  }

  private async drainSettled(
    pending: Map<number, Promise<{ key: number; settled: Settled }>>,
    inflight: Map<number, PeerSource>,
    state: RunState,
    signal?: AbortSignal,
  ): Promise<void> {
    const sentinel = Symbol('no-settled-result');
    // Once `signal` fired, what settles is its own cancellation, not an answer.
    while (pending.size > 0 && signal?.aborted !== true) {
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
    state.settled.add(settled.source.name);
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
}
