import { jest } from '@jest/globals';
import { ok, err, type Result } from 'neverthrow';
import { PeerReviewQuorumUseCase } from '../peer-review-quorum.use-case.js';
import {
  CancellationError,
  EmptyPeerAnswerError,
  TruncatedPeerAnswerError,
  CredentialError,
  PeerRateLimitError,
  QuorumFailureError,
  TransportError,
  ValidationError,
  causeOf,
} from '../../errors/index.js';
import { ExternalServiceError, TimeoutError, type DomainError } from '../../../shared/errors/index.js';
import { promptText, type PeerResponse, type QuorumSourceReport } from '../../entities/index.js';
import type { PeerSource } from '../../ports/index.js';
import {
  makeSource,
  makeArbiter,
  answers,
  peerResponse,
  resolvesOnAbortOnly,
  resolvesAfterDelay,
  slowArbiter,
  scriptedRatings,
} from './helpers.js';
import {
  initialAbortAttribution,
  markCancelledStragglers,
  recordSettled,
  seedReport,
  type AbortOriginFlags,
  type RecordState,
} from '../source-reports.js';
import { markPendingCancelled, markPendingOutage } from '../tier-budget.js';

describe('PeerReviewQuorumUseCase', () => {
  it('reports a no-usable-text peer as error and reaches quorum on remaining weight', async () => {
    const empty = makeSource('empty', 1, 2, async () =>
      err(new ExternalServiceError('Peer returned no usable text (finish_reason=length)', 'empty')),
    );
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Paris.'));
    const arbiter = makeArbiter([{ a: 0.9, b: 0.8 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [empty, a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'Capital of France?' }))._unsafeUnwrap();

    const report = result.sources.find((s) => s.name === 'empty');
    expect(report?.status).toBe('error');
    expect(report?.agreement).toBeNull();
    expect(result.achieved).toBe(true);
    expect(result.agreeingWeight).toBe(4);
    expect(result.certaintyScore).toBeGreaterThan(0);
  });

  it('carries the failure reason into the verdict for every non-ok source', async () => {
    const broken = makeSource('broken', 1, 2, async () =>
      err(new ExternalServiceError('Peer returned no usable text (finish_reason=length)', 'broken')),
    );
    const nokey = makeSource('nokey', 1, 2, answers('nokey', 'unused'), false);
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Paris.'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [broken, nokey, a, b],
      arbiter: makeArbiter([{ a: 0.9, b: 0.8 }]),
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    // A bare status is undiagnosable — the caller only ever sees this envelope.
    expect(result.sources.find((s) => s.name === 'broken')?.error).toContain('finish_reason=length');
    expect(result.sources.find((s) => s.name === 'nokey')?.status).toBe('unavailable');
    expect(result.sources.find((s) => s.name === 'nokey')?.error).toContain('Credential');
    expect(result.sources.find((s) => s.name === 'a')?.error).toBeUndefined();
  });

  it('explains a source that never settled before the run ended', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Paris.'));
    const slow = makeSource('slow', 1, 1, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, slow],
      arbiter: makeArbiter([{ a: 0.9, b: 0.9 }]),
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    const slowReport = result.sources.find((s) => s.name === 'slow');
    // The run no longer needed its vote: the explanation is a non-failure note,
    // not the failure slot.
    expect(slowReport?.status).toBe('cancelled');
    expect(slowReport?.note).toBe('Cancelled: quorum was met before this source responded');
    expect(slowReport?.error).toBeUndefined();
  });

  it('tier-1 quorum stops escalation — no tier-2 source is called', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Paris.'));
    const c = makeSource('c', 2, 2, answers('c', 'Paris!'));
    const arbiter = makeArbiter([{ a: 0.9, b: 0.8 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'Capital of France?' }))._unsafeUnwrap();

    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(1);
    expect(result.requiredWeight).toBe(4);
    expect(result.agreeingWeight).toBe(4);
    expect(result.response).toBe('CONSENSUS');
    expect(result.certaintyScore).toBeCloseTo(0.85); // min(1, 4/4) * mean(0.9, 0.8)
    expect(c.calls).toHaveLength(0);
    expect(result.sources.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('shortfall escalates to tier 2 and re-evaluates over the accumulated set', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Lyon'));
    const c = makeSource('c', 2, 2, answers('c', 'Paris indeed'));
    const arbiter = makeArbiter([
      { a: 0.9, b: 0.2 },
      { a: 0.9, b: 0.2, c: 0.8 },
    ]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(c.calls).toHaveLength(1);
    expect(arbiter.calls).toHaveLength(2);
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
    expect(result.agreeingWeight).toBe(4);
    const bReport = result.sources.find((s) => s.name === 'b');
    expect(bReport?.status).toBe('ok');
    expect(bReport?.agreement).toBe(0.2);
  });

  it('reports a deadline mid-fan-out whose lost weight was lateness as unreachable', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'fast answer'));
    const b = makeSource('b', 1, 2, resolvesOnAbortOnly);
    const arbiter = makeArbiter([{ a: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 50,
    });

    const result = await useCase.execute({ prompt: 'q' });

    // Half the weight died on a clock's abort: the run is unreachable rather than
    // a withheld-prose verdict, because that weight was never attainable.
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as QuorumFailureError;
    expect(error).toBeInstanceOf(QuorumFailureError);
    expect(causeOf(error)).toBe('deadline');
    expect(error.source).toBe('b');
    expect(error.detail).toMatch(/2 of the 4 required/);
    expect(error.detail).toContain('b');
    expect(arbiter.calls).toHaveLength(0);
    // The accumulated partial result stays fully transcribable off the error's
    // roster: the peer that answered, and the row the clock took with its cause.
    expect(error.context?.sources.find((s) => s.name === 'a')?.status).toBe('ok');
    const bReport = error.context?.sources.find((s) => s.name === 'b');
    expect(bReport?.status).toBe('error');
    expect(bReport?.cause).toBe('deadline');
  });

  it('returns at the deadline even when the arbiter ignores the abort', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const arbiter = makeSource('arbiter', 99, 1, () => new Promise(() => undefined));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 100,
    });

    const started = Date.now();
    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(Date.now() - started).toBeLessThan(300);
    expect(arbiter.calls).toHaveLength(1);
    expect(result.achieved).toBe(false);
    expect(result.tier).toBe(1);
    const aReport = result.sources.find((s) => s.name === 'a');
    expect(aReport?.status).toBe('ok');
    // The first evaluation never finished: unrated, and the row says why.
    expect(aReport?.agreement).toBeNull();
    expect(aReport?.note).toBe('Unrated: the run ended before the arbiter rated this source');
  });

  it('early-aborts pending same-tier calls once quorum weight is met', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'yes'));
    const b = makeSource('b', 1, 2, answers('b', 'yes'));
    const slow = makeSource('slow', 1, 1, resolvesOnAbortOnly);
    const arbiter = makeArbiter([{ a: 0.9, b: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, slow],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(result.achieved).toBe(true);
    expect(slow.calls).toHaveLength(1);
    expect(slow.calls[0]?.signal?.aborted).toBe(true);
    const slowReport = result.sources.find((s) => s.name === 'slow');
    expect(slowReport?.status).toBe('cancelled');
    expect(slowReport?.agreement).toBeNull();
    expect(slowReport?.weight).toBe(0); // configured 1: a cancelled peer contributed no vote
    expect(slowReport?.note).toBe('Cancelled: quorum was met before this source responded');
    expect(slowReport?.error).toBeUndefined();
    expect(slowReport?.cause).toBeUndefined();
  });

  // ── stragglers while the arbiter is evaluating ─────────────────────────────

  it('records a peer that settles during an achieving evaluation instead of cancelling it', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'yes'));
    const late = makeSource('late', 1, 1, resolvesAfterDelay(20));
    const never = makeSource('never', 1, 1, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, late, never],
      arbiter: slowArbiter(80, { a: 0.9 }),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
      tierTimeoutMs: { 1: 3000 },
      arbiterTimeoutMs: 1000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(result.achieved).toBe(true);
    const lateReport = result.sources.find((s) => s.name === 'late');
    expect(lateReport?.status).toBe('ok');
    expect(lateReport?.agreement).toBeNull(); // answered after the rating, so unrated
    expect(lateReport?.note).toBe('Unrated: the run ended before the arbiter rated this source');
    expect(result.usage.totalTokens).toBe(45); // a + late + arbiter, 15 each
    expect(result.sources.find((s) => s.name === 'never')?.status).toBe('cancelled');
  });

  it('a global deadline during evaluation leaves the straggler on its seeded error, unlogged', async () => {
    const warnings: string[] = [];
    const a = makeSource('a', 1, 2, answers('a', 'yes'));
    const straggler = makeSource('straggler', 1, 1, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, straggler],
      arbiter: slowArbiter(150, { a: 0.2 }),
      thresholds: { 1: 2 },
      deadlineMs: 60,
      tierTimeoutMs: { 1: 30 },
      arbiterTimeoutMs: 20,
      logger: { warn: (msg: string) => { warnings.push(msg); }, debug: () => undefined },
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    const report = result.sources.find((s) => s.name === 'straggler');
    expect(report?.status).toBe('error');
    expect(report?.error).toBe('No response recorded before the run ended');
    // Not only prose: the straggler names the clock that killed it (task 15).
    expect(report?.cause).toBe('deadline');
    expect(report?.timeoutMs).toBe(60);
    expect(straggler.calls[0]?.signal?.aborted).toBe(true);
    expect(warnings).not.toContain('Peer failed during quorum');
  });

  it('a tier budget during evaluation marks the straggler outage-shaped', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'yes'));
    const straggler = makeSource('straggler', 1, 1, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, straggler],
      arbiter: slowArbiter(150, { a: 0.2 }),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
      tierTimeoutMs: { 1: 60 },
      arbiterTimeoutMs: 1000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    const report = result.sources.find((s) => s.name === 'straggler');
    expect(report?.status).toBe('error');
    expect(report?.error).toContain('tier budget elapsed — still in flight');
    // Pin: the lateness gate turns a not-achieved run into a failure only when
    // the settled weight falls short of the bar — this run's does not, so the
    // withheld-prose envelope above stays its contract.
    expect(
      result.sources
        .filter((s) => s.status === 'ok')
        .reduce((sum, s) => sum + s.weight, 0),
    ).toBeGreaterThanOrEqual(result.requiredWeight);
  });

  it('keeps a peer that settled with a real failure inside the tier-abort window its own cause', async () => {
    // Clock starvation, not a peer outage: `limited` settled with a real 429 the
    // moment the tier slice expired, while an evaluation outlasted it. Stamping
    // it with the tier budget discards the only actionable cause the peer gave.
    const fast = makeSource('fast', 1, 2, answers('fast', 'Paris'));
    const limited = makeSource('limited', 1, 2, async (request) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const signal = request.signal;
      if (signal?.aborted === true) {
        resolve();
      } else {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      }
      await promise;
      return err(new PeerRateLimitError(1000));
    });
    const never = makeSource('never', 1, 2, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [fast, limited, never],
      // A rating below the agreement bar: the evaluation ends without quorum, so
      // the run reaches the tier-abort path with `limited` already settled.
      arbiter: slowArbiter(120, { fast: 0.2 }),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
      // The slice expires mid-evaluation, which is what opens the window.
      tierTimeoutMs: { 1: 50 },
      arbiterTimeoutMs: 1000,
    });

    const result = (await useCase.execute({ prompt: 'Capital of France?' }))._unsafeUnwrap();

    const limitedReport = result.sources.find((s) => s.name === 'limited');
    expect(limitedReport?.status).toBe('error');
    expect(limitedReport?.cause).toBe('rate_limited');
    expect(limitedReport?.error).toContain('Rate limit exceeded');
    // The sibling that never answered stays the clock's own outage.
    const neverReport = result.sources.find((s) => s.name === 'never');
    expect(neverReport?.status).toBe('error');
    expect(neverReport?.cause).toBe('deadline');
    expect(neverReport?.error).toBe('tier budget elapsed — still in flight');
  });

  it('keeps a peer that answered inside its slice while an evaluation outlasted it', async () => {
    const a = makeSource('a', 1, 2, resolvesAfterDelay(100, 'a answer'));
    const b = makeSource('b', 1, 1, resolvesAfterDelay(400, 'b answer'));
    const never = makeSource('never', 1, 1, resolvesOnAbortOnly);
    // First evaluation runs 100–700 ms, past the 500 ms slice; the second is instant.
    let arbiterCall = 0;
    const arbiter = makeSource('arbiter', 99, 1, (request) => {
      arbiterCall += 1;
      const ratings = arbiterCall === 1 ? { a: 0.2 } : { a: 0.9, b: 0.9 };
      const body = scriptedRatings(promptText(request.prompt), ratings);
      const reply = ok(peerResponse('arbiter', JSON.stringify({ consensus: 'CONSENSUS', ratings: body })));
      return arbiterCall === 1
        ? new Promise((resolve) => setTimeout(() => resolve(reply), 600))
        : Promise.resolve(reply);
    });
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, never],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
      tierTimeoutMs: { 1: 500 },
      arbiterTimeoutMs: 1000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    const bReport = result.sources.find((s) => s.name === 'b');
    expect(bReport?.status).toBe('ok');
    expect(bReport?.agreement).toBe(0.9);
    expect(arbiter.calls).toHaveLength(2);
    expect(result.achieved).toBe(true);
    expect(result.agreeingWeight).toBe(3);
    expect(result.sources.find((s) => s.name === 'never')?.error).toContain('tier budget elapsed');
    // Pin: the weight this run could still reach clears the bar, so the
    // lateness gate in `assembleResult` must never take this envelope away.
    expect(
      result.sources
        .filter((s) => s.status === 'ok')
        .reduce((sum, s) => sum + s.weight, 0),
    ).toBeGreaterThanOrEqual(result.requiredWeight);
  });

  it('caller tier limits escalation and picks that tier threshold', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const c = makeSource('c', 2, 2, answers('c', 'x'));
    const arbiter = makeArbiter([{ a: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q', tier: 1 }))._unsafeUnwrap();
    expect(result.achieved).toBe(true);
    expect(result.requiredWeight).toBe(2);
    expect(c.calls).toHaveLength(0);
  });

  it('disagreement at the caller ceiling does NOT escalate past it', async () => {
    // Both tier-1 sources answer — attainable weight (2) meets requiredWeight (2)
    // — but the arbiter rates them as disagreeing. The miss is revisable by the
    // caller, so the ceiling holds and keeps its cost-control meaning.
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const b = makeSource('b', 1, 1, answers('b', 'y'));
    const c = makeSource('c', 2, 2, answers('c', 'z'));
    const arbiter = makeArbiter([{ a: 0.2, b: 0.2 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q', tier: 1 }))._unsafeUnwrap();

    expect(result.achieved).toBe(false);
    expect(c.calls).toHaveLength(0);
    expect(result.tier).toBe(1);
  });

  it('an outage-shaped miss escalates PAST the caller ceiling', async () => {
    // 'b' errors, so attainable weight (1) is below requiredWeight (2) and no
    // re-evaluation over tier 1 can ever clear it. The tier-2 source must be
    // consulted rather than returning an unattainable failure.
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const b = makeSource('b', 1, 1, 'transport-error');
    const c = makeSource('c', 2, 2, answers('c', 'x'));
    const arbiter = makeArbiter([{ a: 1 }, { a: 1, c: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q', tier: 1 }))._unsafeUnwrap();

    expect(c.calls).toHaveLength(1);
    expect(result.tier).toBe(2);
    // The correction from external review (caller agreement 0.6): escalation
    // restores the CAPACITY to reach the caller's bar — it must not RAISE the
    // bar. requiredWeight stays tier 1's 2, never tier 2's 4. The draft design
    // re-derived it, and this assertion is what would have caught that.
    expect(result.requiredWeight).toBe(2);
    expect(result.achieved).toBe(true);
  });

  it('withholds prose when the quorum is unattainable even at the highest tier', async () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const b = makeSource('b', 1, 1, 'transport-error');
    const c = makeSource('c', 2, 2, 'transport-error');
    const arbiter = makeArbiter([{ a: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      arbiter,
      thresholds: { 1: 4, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q', tier: 1 }))._unsafeUnwrap();

    expect(result.achieved).toBe(false);
    expect(result.response).toBe('');
    expect(result.responseWithheld).toBe(true);
    // Metadata complete, so the verdict is still honestly transcribable.
    expect(result.requiredWeight).toBe(4);
    expect(result.sources.find((s) => s.name === 'b')?.status).toBe('error');
    expect(result.sources.find((s) => s.name === 'c')?.status).toBe('error');
  });

  it('an achieved quorum still returns its prose and carries no withheld flag', async () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const b = makeSource('b', 1, 1, answers('b', 'x'));
    const arbiter = makeArbiter([{ a: 1, b: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(result.achieved).toBe(true);
    expect(result.response).not.toBe('');
    expect(result.responseWithheld).toBeUndefined();
  });

  it('rejects a tier without a configured threshold', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter: makeArbiter([{ a: 1 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = await useCase.execute({ prompt: 'q', tier: 9 });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ValidationError);
  });

  it('zeroes certainty when a later tier arbiter re-evaluation fails after an earlier success', async () => {
    const a = makeSource('a', 1, 3, answers('a', 'Paris'));
    const b = makeSource('b', 1, 1, answers('b', 'Lyon'));
    const c = makeSource('c', 2, 2, answers('c', 'Paris too'));
    // Tier-1 eval succeeds (shortfall → escalate), tier-2 re-eval hits a transport error.
    const arbiter = makeArbiter([{ a: 0.9, b: 0.2 }, 'transport-error']);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      arbiter,
      thresholds: { 1: 3, 2: 6 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(arbiter.calls).toHaveLength(2);
    expect(result.achieved).toBe(false);
    expect(result.arbiterFailed).toBe(true);
    // D7: stale tier-1 consensus must not surface with non-zero certainty.
    expect(result.certaintyScore).toBe(0);
    // The fallback prose is withheld too — the quorum was not achieved, so the
    // highest-weighted source's raw answer is exactly the unvalidated opinion
    // this must not hand back. Metadata stays complete.
    expect(result.response).toBe('');
    expect(result.responseWithheld).toBe(true);
    // Stale ratings remain itemized for transparency, but say they are not the
    // latest verdict; the tier-2 peer the failed pass never rated says so too.
    const aReport = result.sources.find((s) => s.name === 'a');
    expect(aReport?.agreement).toBe(0.9);
    expect(aReport?.note).toBe(
      'Rated by an earlier evaluation; the latest arbiter evaluation failed — see quorum.arbiter',
    );
    const cReport = result.sources.find((s) => s.name === 'c');
    expect(cReport?.agreement).toBeNull();
    expect(cReport?.note).toBe('Unrated: the arbiter failed; see quorum.arbiter');
  });

  it('reports a source the arbiter never rated as unrated, never as 0', async () => {
    const warn = jest.fn();
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Lyon'));
    const arbiter = makeArbiter([{ a: 0.9 }]); // b omitted on both attempts
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
      logger: { warn, debug: jest.fn() },
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(arbiter.calls).toHaveLength(2); // one re-ask naming the missing id
    const bReport = result.sources.find((s) => s.name === 'b');
    expect(bReport?.status).toBe('ok');
    expect(bReport?.agreement).toBeNull();
    expect(bReport?.note).toBe('Unrated: the arbiter returned no rating for this source');
    expect(bReport?.reason).toBeUndefined();
    expect(result.agreeingWeight).toBe(2); // b contributes no weight
    expect(result.certaintyScore).toBeCloseTo(0.45); // min(1, 2/4) × 0.9 — b not in the mean
    expect(warn).toHaveBeenCalledWith('Arbiter returned no rating for a source', {
      source: 'b',
      arbiter: 'arbiter',
    });
  });

  it('explains every rated score on a failed quorum while withholding the prose', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Lyon'));
    const arbiter = makeArbiter([
      {
        a: { agreement: 0.9, reason: 'States the consensus.' },
        b: { agreement: 0.2, reason: 'Names a different city.' },
      },
    ]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(result.achieved).toBe(false);
    expect(result.response).toBe('');
    expect(result.responseWithheld).toBe(true);
    expect(result.sources.find((s) => s.name === 'a')?.reason).toBe('States the consensus.');
    const bReport = result.sources.find((s) => s.name === 'b');
    expect(bReport?.agreement).toBe(0.2);
    expect(bReport?.reason).toBe('Names a different city.');
    expect(bReport?.note).toBeUndefined();
  });

  it('names a rating by the configured source, not by what the adapter echoed', async () => {
    // resolvesAfterDelay answers with PeerResponse.source 'slow' for every source.
    const a = makeSource('a', 1, 2, resolvesAfterDelay(5, 'first'));
    const b = makeSource('b', 1, 2, resolvesAfterDelay(10, 'second'));
    const arbiter = makeArbiter([{ D1: 0.9, D2: 0.8 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(result.sources.find((s) => s.name === 'a')?.agreement).toBe(0.9);
    expect(result.sources.find((s) => s.name === 'b')?.agreement).toBe(0.8);
    expect(result.achieved).toBe(true);
  });

  it('never sends the caller answer to peers', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const b = makeSource('b', 1, 2, answers('b', 'y'));
    const arbiter = makeArbiter([{ a: 0.9, b: 0.9, caller: 0.8 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerAnswer: 'MY-SECRET-DRAFT' })
    )._unsafeUnwrap();

    expect(JSON.stringify(a.calls)).not.toContain('MY-SECRET-DRAFT');
    expect(JSON.stringify(b.calls)).not.toContain('MY-SECRET-DRAFT');
    expect(promptText(arbiter.calls[0]!.prompt)).toContain('MY-SECRET-DRAFT');
    expect(result.callerAgreement).toBe(0.8);
  });

  it('caller rating cannot self-certify: zero quorum weight, no sources[] entry', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Lyon'));
    const arbiter = makeArbiter([{ a: 0.9, b: 0.2, caller: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerAnswer: 'Paris, obviously' })
    )._unsafeUnwrap();

    expect(result.achieved).toBe(false);
    expect(result.agreeingWeight).toBe(2); // a only — caller's 1.0 adds nothing
    expect(result.certaintyScore).toBeCloseTo(0.45); // min(1, 2/4) × 0.9, caller excluded
    expect(result.callerAgreement).toBe(1);
    expect(result.sources.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('last tier re-evaluation wins for the caller rating', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Lyon'));
    const c = makeSource('c', 2, 2, answers('c', 'Paris indeed'));
    const arbiter = makeArbiter([
      { a: 0.9, b: 0.2, caller: 0.3 },
      { a: 0.9, b: 0.2, c: 0.8, caller: 0.9 },
    ]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerAnswer: 'Paris' })
    )._unsafeUnwrap();

    expect(arbiter.calls).toHaveLength(2);
    expect(result.achieved).toBe(true);
    expect(result.callerAgreement).toBe(0.9);
  });

  it('reports a null caller rating on the arbiter-failure fallback path', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const arbiter = makeArbiter(['transport-error']);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerAnswer: 'mine' })
    )._unsafeUnwrap();

    expect(result.arbiterFailed).toBe(true);
    expect(result.callerAgreement).toBeNull();
  });

  it('carries no callerAgreement property when no caller answer was supplied', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const arbiter = makeArbiter([{ a: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect('callerAgreement' in result).toBe(false);
  });

  it('aggregates token usage across peers and arbiter', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const arbiter = makeArbiter([{ a: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();
    // one peer call (15 total) + one arbiter call (15 total)
    expect(result.usage.totalTokens).toBe(30);
  });

  // ── callerSource: skip the redundant peer (A2/A3) ──────────────────────────

  it('skips the caller source: never calls it and itemizes it as status "skipped"', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const self = makeSource('self', 1, 2, answers('self', 'unused'));
    const arbiter = makeArbiter([{ a: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, self],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerSource: 'self' })
    )._unsafeUnwrap();

    expect(self.calls).toHaveLength(0); // no outbound call to the redundant peer
    const selfReport = result.sources.find((s) => s.name === 'self');
    expect(selfReport?.status).toBe('skipped');
    expect(selfReport?.agreement).toBeNull();
    expect(a.calls).toHaveLength(1);
    expect(result.achieved).toBe(true);
  });

  it('skipping the caller source drops tier-1 below threshold and escalates', async () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const self = makeSource('self', 1, 1, answers('self', 'unused'));
    const c = makeSource('c', 2, 2, answers('c', 'x'));
    const arbiter = makeArbiter([{ a: 1 }, { a: 1, c: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, self, c],
      arbiter,
      thresholds: { 1: 2, 2: 2 },
      deadlineMs: 5000,
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerSource: 'self' })
    )._unsafeUnwrap();

    expect(self.calls).toHaveLength(0);
    expect(result.sources.find((s) => s.name === 'self')?.status).toBe('skipped');
    expect(c.calls).toHaveLength(1); // escalated because the skip made tier 1 unreachable
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('an unknown callerSource is a logged no-op that runs the full quorum', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Paris.'));
    const arbiter = makeArbiter([{ a: 0.9, b: 0.9 }]);
    let warnings = 0;
    let lastMeta: unknown;
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
      logger: {
        warn: (_msg: string, meta?: unknown) => {
          warnings += 1;
          lastMeta = meta;
        },
        debug: () => undefined,
      },
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerSource: 'ghost' })
    )._unsafeUnwrap();

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1); // nothing skipped — full quorum runs
    expect(result.achieved).toBe(true);
    expect(warnings).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(lastMeta)).toContain('ghost');
    expect(result.sources.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  // ── per-tier budget: slow-but-alive escalation (B1/B2) ─────────────────────

  it('a slow-but-alive tier-1 source escalates to tier 2 within the deadline', async () => {
    const slow = makeSource('slow', 1, 2, resolvesAfterDelay(10000));
    const c1 = makeSource('c1', 2, 1, answers('c1', 'x'));
    const c2 = makeSource('c2', 2, 1, answers('c2', 'x'));
    const arbiter = makeArbiter([{ c1: 0.9, c2: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [slow, c1, c2],
      arbiter,
      thresholds: { 1: 2, 2: 2 },
      // tier-1 budget ≈ 600/2 = 300ms; the slow peer (10s) never settles inside
      // it, so escalation must fire well before the 600ms outer wall.
      deadlineMs: 600,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(slow.calls).toHaveLength(1); // it WAS launched...
    const slowReport = result.sources.find((s) => s.name === 'slow');
    expect(slowReport?.status).toBe('error'); // ...then abandoned as outage-shaped
    expect(slowReport?.error).toContain('tier budget');
    expect(c1.calls).toHaveLength(1);
    expect(c2.calls).toHaveLength(1);
    expect(result.achieved).toBe(true); // achieved, NOT a global-deadline partial
    expect(result.tier).toBe(2);
    expect(result.responseWithheld).toBeUndefined();
  });

  it('preserves the configured final-tier peer allowance before arbitration', async () => {
    const slow = makeSource('slow', 1, 1, resolvesOnAbortOnly);
    const kimi = makeSource('kimi', 2, 2, resolvesAfterDelay(58, 'Kimi answer'));
    const arbiter = makeArbiter([{ kimi: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [slow, kimi],
      arbiter,
      thresholds: { 1: 2, 2: 2 },
      // The validated schedule is t1 peer (30) + arbiter (20) + t2 peer (60)
      // + arbiter (20). A shared 130ms deadline slice would cap tier 2 at
      // about 55ms after tier 1, incorrectly aborting the 58ms final peer.
      deadlineMs: 130,
      tierTimeoutMs: { 1: 30, 2: 60 },
      arbiterTimeoutMs: 20,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(slow.calls).toHaveLength(1);
    expect(kimi.calls).toHaveLength(1);
    expect(result.sources.find((s) => s.name === 'kimi')?.status).toBe('ok');
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
  });

  // ── final tier capped by the remaining deadline (280 s wall, 1000:1 scale) ──

  it('caps a final-tier peer at the remaining deadline minus the arbiter reserve', async () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const c = makeSource('c', 2, 1, answers('c', 'x'));
    const opus = makeSource('opus', 2, 2, resolvesOnAbortOnly);
    const arbiter = makeArbiter([{ a: 1 }, { a: 1, c: 0.2 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, c, opus],
      arbiter,
      thresholds: { 1: 2, 2: 2 },
      deadlineMs: 280,
      tierTimeoutMs: { 1: 120, 2: 300 },
      arbiterTimeoutMs: 120,
    });

    const started = Date.now();
    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();
    const elapsed = Date.now() - started;

    // The tier-2 wave ends at 280 − 120 = 160, leaving the arbiter its reserve.
    expect(elapsed).toBeLessThan(250);
    expect(arbiter.calls).toHaveLength(2); // the arbiter rated what arrived
    expect(result.sources.find((s) => s.name === 'c')?.agreement).toBe(0.2);
    expect(result.achieved).toBe(false);
    expect(result.tier).toBe(2);
    const opusReport = result.sources.find((s) => s.name === 'opus');
    expect(opusReport?.status).toBe('error');
    expect(opusReport?.error).toContain('tier budget elapsed');
    // Pin: 'a' and 'c' answered, so the settled weight clears the bar — the
    // lateness gate must leave this run on the withheld-prose envelope.
    expect(
      result.sources
        .filter((s) => s.status === 'ok')
        .reduce((sum, s) => sum + s.weight, 0),
    ).toBeGreaterThanOrEqual(result.requiredWeight);
  });

  it('reports the quorum unreachable when the weight it lost was dropped for lateness', async () => {
    // The live shape: the weight-3 source is still in flight when its tier's
    // slice expires, so its weight was never attainable. That run is not a
    // low-certainty verdict — it is unreachable, and must say so.
    const haiku = makeSource('haiku', 1, 1, answers('haiku', 'Paris'));
    const sonnet = makeSource('sonnet', 2, 3, resolvesOnAbortOnly);
    const arbiter = makeArbiter([{ haiku: 0.2 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [haiku, sonnet],
      arbiter,
      thresholds: { 1: 2, 2: 3 },
      // Tier 2's slice (100 ms) expires well before the 280 ms wall, so `sonnet`
      // is stamped by the tier slice (no `timeoutMs`), not by its own timeout.
      deadlineMs: 280,
      tierTimeoutMs: { 1: 40, 2: 100 },
      arbiterTimeoutMs: 60,
    });

    const result = await useCase.execute({ prompt: 'Capital of France?' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as QuorumFailureError;
    expect(error).toBeInstanceOf(QuorumFailureError);
    expect(causeOf(error)).toBe('deadline');
    expect(error.source).toBe('sonnet');
    expect(error.detail).toMatch(/1 of the 3 required/);
    expect(error.detail).toContain('sonnet');
    expect(error.fix).toContain('PEER_REVIEW_DEADLINE_MS');
    expect(error.fix).toContain('maxOutputTokens');
    expect(error.fix).toContain('sonnet');
    // The roster survives the move onto the failure path: the peer that answered
    // is still itemized with its weight and rating.
    expect(error.context?.tier).toBe(2);
    expect(error.context?.requiredWeight).toBe(3);
    expect(error.context?.agreeingWeight).toBe(0);
    const answered = error.context?.sources.find((s) => s.name === 'haiku');
    expect(answered?.status).toBe('ok');
    expect(answered?.weight).toBe(1);
    expect(answered?.agreement).toBe(0.2);
    const late = error.context?.sources.find((s) => s.name === 'sonnet');
    expect(late?.status).toBe('error');
    expect(late?.cause).toBe('deadline');
  });

  it('keeps the withheld-prose envelope when the missing weight belongs to a transport-error peer', async () => {
    // Keyed on lateness alone: the same shape of shortfall owned by a peer that
    // failed for another reason keeps today's success envelope and its own cause.
    const haiku = makeSource('haiku', 1, 1, answers('haiku', 'Paris'));
    const sonnet = makeSource(
      'sonnet',
      2,
      3,
      async () =>
        err(new TransportError('Network error: TypeError: fetch failed', 'sonnet', 'ECONNREFUSED')),
    );
    const arbiter = makeArbiter([{ haiku: 0.2 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [haiku, sonnet],
      arbiter,
      thresholds: { 1: 2, 2: 3 },
      deadlineMs: 5000,
    });

    const result = await useCase.execute({ prompt: 'Capital of France?' });

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.achieved).toBe(false);
    expect(value.response).toBe('');
    expect(value.responseWithheld).toBe(true);
    expect(value.certaintyScore).toBe(0);
    expect(value.requiredWeight).toBe(3);
    const sonnetReport = value.sources.find((s) => s.name === 'sonnet');
    expect(sonnetReport?.status).toBe('error');
    expect(sonnetReport?.cause).toBe('peer_unreachable');
  });

  it('rates a final-tier peer that answers inside its capped slice', async () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const c = makeSource('c', 2, 1, answers('c', 'x'));
    const opus = makeSource('opus', 2, 2, resolvesAfterDelay(100, 'opus answer'));
    const arbiter = makeArbiter([{ a: 1 }, { a: 1, c: 1, opus: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, c, opus],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 280,
      tierTimeoutMs: { 1: 120, 2: 300 },
      arbiterTimeoutMs: 120,
    });

    const started = Date.now();
    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(Date.now() - started).toBeLessThan(280);
    expect(result.sources.find((s) => s.name === 'opus')?.status).toBe('ok');
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('skips a tier with no time left after the arbiter reserve', async () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const opus = makeSource('opus', 2, 2, answers('opus', 'x'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, opus],
      // Tier 1's evaluation runs to 200, so 280 − 200 − 120 leaves tier 2 nothing.
      arbiter: slowArbiter(200, { a: 1 }),
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 280,
      tierTimeoutMs: { 1: 120, 2: 300 },
      arbiterTimeoutMs: 120,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(opus.calls).toHaveLength(0);
    const opusReport = result.sources.find((s) => s.name === 'opus');
    expect(opusReport?.status).toBe('skipped');
    expect(opusReport?.error).toBe('Skipped: no time left before the deadline after the arbiter reserve');
    expect(result.achieved).toBe(false);
    expect(result.tier).toBe(1);
  });

  it('itemizes a time-skipped tier with the deadline cause and never overwrites a credential row', async () => {
    // The clock starved this tier, so every row it itemizes names the clock — and
    // a source that was already absent for its credential keeps saying so.
    const a = makeSource('a', 1, 1, answers('a', 'x'));
    const opus = makeSource('opus', 2, 2, answers('opus', 'x'));
    const nokey = makeSource('nokey', 2, 1, answers('nokey', 'unused'), false);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, opus, nokey],
      // Tier 1's evaluation runs to 200, so 280 − 200 − 120 leaves tier 2 nothing.
      arbiter: slowArbiter(200, { a: 1 }),
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 280,
      tierTimeoutMs: { 1: 120, 2: 300 },
      arbiterTimeoutMs: 120,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(opus.calls).toHaveLength(0);
    expect(nokey.calls).toHaveLength(0);
    const opusReport = result.sources.find((s) => s.name === 'opus');
    expect(opusReport?.status).toBe('skipped');
    expect(opusReport?.error).toBe('Skipped: no time left before the deadline after the arbiter reserve');
    // Machine cause the clock, so the repair is the budget, not callerSource.
    expect(opusReport?.cause).toBe('deadline');
    const nokeyReport = result.sources.find((s) => s.name === 'nokey');
    expect(nokeyReport?.status).toBe('unavailable');
    expect(nokeyReport?.cause).toBe('credential');
    expect(nokeyReport?.error).toBe('Credential not resolvable; source skipped');
    expect(result.achieved).toBe(false);
    expect(result.tier).toBe(1);
  });

  it('preserves a tier-1 success and re-evaluates it after a straggler forces escalation', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const slow = makeSource('slow', 1, 1, resolvesAfterDelay(10000));
    const c = makeSource('c', 2, 2, answers('c', 'Paris too'));
    const arbiter = makeArbiter([{ a: 0.9, c: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, slow, c],
      arbiter,
      thresholds: { 1: 5, 2: 4 },
      deadlineMs: 600,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    // The tier-1 success 'a' survives escalation and is rated in the tier-2 pass.
    const aReport = result.sources.find((s) => s.name === 'a');
    expect(aReport?.status).toBe('ok');
    expect(aReport?.agreement).toBe(0.9);
    expect(result.agreeingWeight).toBe(4); // a(2) + c(2), accumulated across tiers
    expect(result.tier).toBe(2);
    expect(result.achieved).toBe(true);
    expect(result.sources.find((s) => s.name === 'slow')?.status).toBe('error');
    expect(c.calls).toHaveLength(1);
  });

  // ── arbiter is bounded and not conflated with disagreement (C1) ────────────

  it('arbiter failure at the caller ceiling escalates to a fresh arbiter attempt', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const c = makeSource('c', 2, 2, answers('c', 'x'));
    // Tier-1 arbiter attempt fails; a healthy tier-2 attempt then renders a verdict.
    const arbiter = makeArbiter(['transport-error', { a: 1, c: 1 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q', tier: 1 }))._unsafeUnwrap();

    // Attainable weight met the tier-1 bar, but the arbiter FAILED — that is not
    // peer disagreement, so the ceiling must not hold: escalate and re-arbitrate.
    expect(arbiter.calls).toHaveLength(2);
    expect(c.calls).toHaveLength(1);
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
    expect(result.arbiterFailed).toBeUndefined();
  });

  // ── skipLocal: exclude the class of local sources (PEER_REVIEW_SKIP_LOCAL) ──

  it('skipLocal excludes every local source and escalates past the emptied tier', async () => {
    const localA = makeSource('localA', 1, 1, answers('localA', 'unused'), true, true);
    const localB = makeSource('localB', 1, 1, answers('localB', 'unused'), true, true);
    const cloud = makeSource('cloud', 2, 2, answers('cloud', 'x'));
    const arbiter = makeArbiter([{ cloud: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [localA, localB, cloud],
      arbiter,
      thresholds: { 1: 2, 2: 2 },
      deadlineMs: 5000,
      skipLocal: true,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(localA.calls).toHaveLength(0);
    expect(localB.calls).toHaveLength(0);
    expect(result.sources.find((s) => s.name === 'localA')?.status).toBe('skipped');
    expect(result.sources.find((s) => s.name === 'localB')?.status).toBe('skipped');
    expect(result.sources.find((s) => s.name === 'localA')?.agreement).toBeNull();
    expect(cloud.calls).toHaveLength(1); // escalated to the cloud tier
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('skipLocal composes with callerSource as a union of exclusions', async () => {
    const localA = makeSource('localA', 1, 1, answers('localA', 'unused'), true, true);
    const named = makeSource('named', 1, 1, answers('named', 'unused')); // not local
    const cloud = makeSource('cloud', 2, 2, answers('cloud', 'x'));
    const arbiter = makeArbiter([{ cloud: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [localA, named, cloud],
      arbiter,
      thresholds: { 1: 2, 2: 2 },
      deadlineMs: 5000,
      skipLocal: true,
    });

    const result = (
      await useCase.execute({ prompt: 'q', callerSource: 'named' })
    )._unsafeUnwrap();

    expect(localA.calls).toHaveLength(0); // skipped by skipLocal
    expect(named.calls).toHaveLength(0); // skipped by callerSource
    expect(result.sources.find((s) => s.name === 'localA')?.status).toBe('skipped');
    expect(result.sources.find((s) => s.name === 'named')?.status).toBe('skipped');
    expect(cloud.calls).toHaveLength(1);
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('skipLocal with no local source runs the full quorum unchanged', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const b = makeSource('b', 1, 2, answers('b', 'Paris.'));
    const arbiter = makeArbiter([{ a: 0.9, b: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
      skipLocal: true, // set, but nothing is flagged local → no-op
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(result.achieved).toBe(true);
    expect(result.sources.some((s) => s.status === 'skipped')).toBe(false);
  });

  it('does NOT skip local sources when skipLocal is unset', async () => {
    const local = makeSource('local', 1, 2, answers('local', 'x'), true, true);
    const b = makeSource('b', 1, 2, answers('b', 'x'));
    const arbiter = makeArbiter([{ local: 0.9, b: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [local, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(local.calls).toHaveLength(1); // consulted normally
    expect(result.sources.find((s) => s.name === 'local')?.status).toBe('ok');
    expect(result.achieved).toBe(true);
  });

  it('a slow (contended) arbiter is bounded by the tier budget and escalates', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'x'));
    const c = makeSource('c', 2, 2, answers('c', 'x'));
    // The arbiter's first call hangs until aborted (contended); the second is healthy.
    let arbiterCall = 0;
    const arbiterComplete = (request: {
      prompt: string;
      signal?: AbortSignal | undefined;
    }): Promise<Result<PeerResponse, DomainError>> => {
      const attempt = arbiterCall;
      arbiterCall += 1;
      if (attempt === 0) {
        return new Promise((resolve) => {
          const fail = (): void => resolve(err(new TimeoutError('arbiter aborted', 1)));
          if (request.signal?.aborted === true) {
            fail();
            return;
          }
          request.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      return Promise.resolve(
        ok(
          peerResponse(
            'arbiter',
            JSON.stringify({
              consensus: 'CONSENSUS',
              ratings: scriptedRatings(promptText(request.prompt), { a: 1, c: 1 }),
            }),
          ),
        ),
      );
    };
    const arbiter = makeSource('arbiter', 99, 1, arbiterComplete);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, c],
      arbiter,
      thresholds: { 1: 2, 2: 4 },
      deadlineMs: 600, // tier-1 budget ≈ 300ms bounds the hung arbiter
    });

    const result = (await useCase.execute({ prompt: 'q', tier: 1 }))._unsafeUnwrap();

    expect(arbiter.calls).toHaveLength(2); // first bounded+aborted, second healthy
    expect(result.achieved).toBe(true);
    expect(result.tier).toBe(2);
  });
});

describe('PeerReviewQuorumUseCase: failure contract (tasks 3, 4, 15)', () => {
  const prompt = 'Which transport is best for 500 km cargo, and why?';

  it('records the arbiter cause when the arbiter answers in prose (task 3)', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter: makeArbiter(['garbage']),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = (await useCase.execute({ prompt }))._unsafeUnwrap();
    expect(result.arbiterFailed).toBe(true);
    expect(result.arbiter).toEqual({
      name: 'arbiter',
      status: 'failed',
      error: {
        code: 'EXTERNAL_SERVICE_ERROR',
        cause: 'arbiter_malformed',
        detail: 'arbiter "arbiter" reply failed JSON extraction after one re-ask',
      },
    });
  });

  it('records an unavailable arbiter when the arbiter call itself fails (task 3)', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter: makeArbiter(['transport-error']),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = (await useCase.execute({ prompt }))._unsafeUnwrap();
    expect(result.arbiterFailed).toBe(true);
    expect(result.arbiter?.error.cause).toBe('arbiter_unavailable');
    expect(result.arbiter?.name).toBe('arbiter');
  });

  it('keeps the arbiter failure in the failure envelope when no peer got through (task 4)', async () => {
    const down = makeSource(
      'down',
      1,
      2,
      async () => err(new TransportError('Network error: TypeError: fetch failed', 'down', 'ECONNREFUSED')),
    );
    const useCase = new PeerReviewQuorumUseCase({
      sources: [down],
      arbiter: makeArbiter(['transport-error']),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const failure = (await useCase.execute({ prompt }))._unsafeUnwrapErr();
    expect(failure).toBeInstanceOf(QuorumFailureError);
    const error = failure as QuorumFailureError;
    expect(error.message).toBe('No peer source produced a response');
    // The arbiter is only consulted once something succeeded — no invented row.
    expect(error.context?.arbiter).toBeUndefined();
    expect(error.context?.sources).toHaveLength(1);
    expect(error.context?.sources[0]?.cause).toBe('peer_unreachable');
  });

  it('names the output ceiling when the arbiter is truncated by its own budget', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const arbiter = makeSource('arbiter', 1, 1, async () =>
      err(
        new TruncatedPeerAnswerError(
          'Peer stopped at max_tokens (finish_reason=length, completion=8192)',
          'arbiter',
          'length',
          8192,
        ),
      ),
    );
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = (await useCase.execute({ prompt }))._unsafeUnwrap();
    // The repair is the output budget, not "check reachability and credentials".
    expect(result.arbiterFailed).toBe(true);
    expect(result.arbiter?.error.cause).toBe('peer_truncated');
    expect(result.arbiter?.error.detail).toContain('stop_reason=length');
    expect(result.arbiter?.error.detail).toContain('completion=8192');
    // The arbiter's own failure must not blame a healthy peer.
    expect(result.sources.find((s) => s.name === 'a')?.status).toBe('ok');
  });

  it('reports a textless arbiter reply as a malformed reply, not an outage', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const arbiter = makeSource('arbiter', 1, 1, async () =>
      err(
        new EmptyPeerAnswerError(
          'Peer returned no usable text (stop_reason=refusal, completion=0)',
          'arbiter',
          'refusal',
          0,
        ),
      ),
    );
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a],
      arbiter,
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = (await useCase.execute({ prompt }))._unsafeUnwrap();
    expect(result.arbiterFailed).toBe(true);
    expect(result.arbiter?.error.cause).toBe('arbiter_malformed');
    expect(result.sources.find((s) => s.name === 'a')?.status).toBe('ok');
  });

  it('keeps the roster and the billed tokens when every consulted source is truncated', async () => {
    const claude = makeSource('claude', 1, 2, async () =>
      err(
        new TruncatedPeerAnswerError(
          'Peer stopped at max_tokens (stop_reason=max_tokens, completion=8192)',
          'claude',
          'max_tokens',
          8192,
        ),
      ),
    );
    const useCase = new PeerReviewQuorumUseCase({
      sources: [claude],
      arbiter: makeArbiter([{ claude: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const failure = (await useCase.execute({ prompt }))._unsafeUnwrapErr() as QuorumFailureError;
    expect(failure).toBeInstanceOf(QuorumFailureError);
    // The no-success response stays as diagnosable as the success one: the roster
    // rides the failure, and the burn the source billed is named on its own row.
    expect(failure.cause).toBe('peer_truncated');
    expect(failure.context?.sources).toHaveLength(1);
    expect(failure.context?.sources[0]?.cause).toBe('peer_truncated');
    expect(failure.context?.sources[0]?.error).toContain('completion=8192');
  });

  it('names the three total-outage shapes apart with distinct causes (task 4)', async () => {
    const refused = makeSource(
      'refused',
      1,
      2,
      async () => err(new TransportError('Network error: TypeError: fetch failed', 'refused', 'ECONNREFUSED')),
    );
    const outage = (await new PeerReviewQuorumUseCase({
      sources: [refused],
      arbiter: makeArbiter([{ refused: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    }).execute({ prompt }))._unsafeUnwrapErr() as QuorumFailureError;

    const noKey = makeSource('no-key', 1, 2, answers('no-key', 'x'), false);
    const credential = (await new PeerReviewQuorumUseCase({
      sources: [noKey],
      arbiter: makeArbiter([{ 'no-key': 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    }).execute({ prompt }))._unsafeUnwrapErr() as QuorumFailureError;

    const me = makeSource('me', 1, 2, answers('me', 'x'));
    const skipped = (await new PeerReviewQuorumUseCase({
      sources: [me],
      arbiter: makeArbiter([{ me: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    }).execute({ prompt, callerSource: 'me' }))._unsafeUnwrapErr() as QuorumFailureError;

    expect(outage.cause).toBe('peer_unreachable');
    expect(outage.source).toBe('refused');
    expect(credential.cause).toBe('credential');
    expect(skipped.cause).toBe('configuration');
    // A configuration fault never reads as a network fault.
    expect(new Set([outage.cause, credential.cause, skipped.cause]).size).toBe(3);
    for (const failure of [outage, credential, skipped]) {
      expect(failure.context).toBeDefined();
      expect(failure.context?.sources.length).toBeGreaterThan(0);
      expect(typeof failure.fix).toBe('string');
      expect(typeof failure.detail).toBe('string');
    }
  });

  it('names 401 and refused-connection fleets apart, not both as generic outage (task 4)', async () => {
    const denied = makeSource('denied', 1, 2, async () => err(new CredentialError('Authentication failed for "denied" (HTTP 401)')));
    const refused = makeSource(
      'refused',
      1,
      2,
      async () => err(new TransportError('Network error: TypeError: fetch failed', 'refused', 'ECONNREFUSED')),
    );
    const deniedRun = (await new PeerReviewQuorumUseCase({
      sources: [denied],
      arbiter: makeArbiter([{ denied: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    }).execute({ prompt }))._unsafeUnwrapErr() as QuorumFailureError;
    const refusedRun = (await new PeerReviewQuorumUseCase({
      sources: [refused],
      arbiter: makeArbiter([{ refused: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    }).execute({ prompt }))._unsafeUnwrapErr() as QuorumFailureError;
    expect(deniedRun.cause).toBe('credential');
    expect(refusedRun.cause).toBe('peer_unreachable');
  });

  it('reports a failed source with its own typed cause, not only prose (task 15)', async () => {
    const timedOut = makeSource('slow', 1, 2, async () => err(new TimeoutError('Request to "slow" was aborted', 250)));
    const denied = makeSource('denied', 1, 2, async () => err(new CredentialError('Authentication failed for "denied" (HTTP 401)')));
    const healthy = makeSource('healthy', 1, 2, answers('healthy', 'train'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [healthy, timedOut, denied],
      arbiter: makeArbiter([{ healthy: 0.9, slow: 0.9, denied: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = (await useCase.execute({ prompt }))._unsafeUnwrap();
    const slow = result.sources.find((s) => s.name === 'slow');
    expect(slow?.cause).toBe('deadline');
    expect(slow?.timeoutMs).toBe(250);
    expect(slow?.error).toContain('aborted');
    const deniedReport = result.sources.find((s) => s.name === 'denied');
    expect(deniedReport?.cause).toBe('credential');
    expect(deniedReport?.code).toBe('CONFIGURATION_ERROR');
  });

  it('gives the top-level cause to the highest-weight failed source (design invariant)', async () => {
    const light = makeSource('light', 1, 1, async () => err(new TransportError('Network error: fetch failed', 'light', 'ECONNREFUSED')));
    const heavy = makeSource('heavy', 1, 3, async () => err(new CredentialError('Authentication failed for "heavy" (HTTP 401)')));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [light, heavy],
      arbiter: makeArbiter([{ light: 0.9, heavy: 0.9 }]),
      thresholds: { 1: 5 },
      deadlineMs: 5000,
    });
    const failure = (await useCase.execute({ prompt }))._unsafeUnwrapErr() as QuorumFailureError;
    expect(failure.cause).toBe('credential');
    expect(failure.source).toBe('heavy');
    // The roster keeps each source's own cause beside the top-level one.
    expect(failure.context?.sources.find((s) => s.name === 'light')?.cause).toBe('peer_unreachable');
  });

  it('gives a never-settled straggler the run deadline cause with its budget (task 15)', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const never = makeSource('b', 1, 2, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, never],
      // With no evaluation running, this single tier's fallback budget ends at
      // the same ~60 ms as the wall and whichever fires first marks b (flaked
      // ~30%). Here a's answer alone makes quorum possible, so an evaluation
      // starts and outlasts the wall; it rates a below threshold, so nothing
      // early-aborts b — the wall is the clock that ends b.
      arbiter: slowArbiter(150, { a: 0.2 }),
      thresholds: { 1: 2 },
      deadlineMs: 60,
      tierTimeoutMs: { 1: 30 },
      arbiterTimeoutMs: 20,
    });
    const result = (await useCase.execute({ prompt }))._unsafeUnwrap();
    const report = result.sources.find((s) => s.name === 'b');
    expect(report?.status).toBe('error');
    expect(report?.cause).toBe('deadline');
    expect(report?.timeoutMs).toBe(60);
    expect(a.calls[0]?.signal?.aborted).toBe(true);
  });
});

// ── abort attribution: a clock that expired fails a peer; an abort the run
// caused cancels it (report-cancelled-peers-as-non-failures) ─────────────────

describe('PeerReviewQuorumUseCase: abort attribution', () => {
  const prompt = 'Capital of France?';
  const QUORUM_MET_NOTE = 'Cancelled: quorum was met before this source responded';
  const CALLER_NOTE = 'Cancelled: the caller cancelled the call before this source responded';

  /** The error the HTTP adapter produces for an orchestrator abort. */
  const cancelError = (name: string): DomainError =>
    new CancellationError(`Request to "${name}" was cancelled by the orchestrator`, name);

  /** The field combination a roster row may carry; anything else the row grows
   * (a stray failure slot on a non-failure row) fails the comparison. */
  function rosterRow(
    row:
      | Pick<QuorumSourceReport, 'status' | 'weight' | 'agreement' | 'error' | 'cause' | 'note' | 'timeoutMs'>
      | undefined,
  ) {
    return {
      status: row?.status,
      weight: row?.weight,
      agreement: row?.agreement,
      error: row?.error,
      cause: row?.cause,
      note: row?.note,
      timeoutMs: row?.timeoutMs,
    };
  }

  function collectors() {
    const warnings: string[] = [];
    const debugs: string[] = [];
    return {
      warnings,
      debugs,
      logger: {
        warn: (message: string) => {
          warnings.push(message);
        },
        debug: (message: string) => {
          debugs.push(message);
        },
      },
    };
  }

  const byName = (sources: readonly QuorumSourceReport[], name: string) =>
    sources.find((s) => s.name === name);

  /** Fold one settled `Err` into a fresh single-row run under the given origin
   * flags — the attribution decision with the race taken out of it. */
  function recordCase(
    flags: Partial<AbortOriginFlags>,
    name: string,
    error: DomainError,
    logger: { warn: (m: string) => void; debug: (m: string) => void },
  ) {
    const source = makeSource(name, 1, 2, answers(name, 'x'));
    const report = seedReport(source);
    const state: RecordState = {
      ...initialAbortAttribution(),
      ...flags,
      reports: new Map([[source.name, report]]),
      settled: new Set<string>(),
      successes: [],
      usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    recordSettled(state, { source, result: err(error) }, logger);
    return report;
  }

  it('reports in-flight peers as cancelled, not tier-budget outages, when the caller cancels mid-run', async () => {
    const caller = new AbortController();
    // The caller walks away from inside the wave, so the run unwinds on its abort
    // while both peers are still in flight — whichever of the two the orchestrator
    // manages to observe, the row must read the same way.
    const leaves = makeSource('leaves', 1, 2, (request) => {
      const { promise, resolve } = Promise.withResolvers<Result<PeerResponse, DomainError>>();
      request.signal?.addEventListener(
        'abort',
        () => resolve(err(cancelError('leaves'))),
        { once: true },
      );
      caller.abort();
      return promise;
    });
    const straggler = makeSource('straggler', 1, 2, resolvesOnAbortOnly);
    const { warnings, logger } = collectors();
    const useCase = new PeerReviewQuorumUseCase({
      sources: [leaves, straggler],
      arbiter: makeArbiter([{ leaves: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
      logger,
    });

    const failure = (await useCase.execute({ prompt }, caller.signal))._unsafeUnwrapErr() as QuorumFailureError;

    // F2: before this change the caller's own abort either stamped every in-flight
    // peer with TierBudgetElapsedError (cause 'deadline') or left the seeded
    // "no response recorded" error on it — a fleet-wide outage nobody caused.
    const rows = failure.context?.sources ?? [];
    expect(rows.map((r) => r.name).sort()).toEqual(['leaves', 'straggler']);
    for (const name of ['leaves', 'straggler']) {
      expect(rosterRow(byName(rows, name))).toEqual({
        status: 'cancelled',
        weight: 0, // configured 2
        agreement: null,
        error: undefined,
        cause: undefined,
        note: CALLER_NOTE,
        timeoutMs: undefined,
      });
    }
    expect(JSON.stringify(rows)).not.toContain('tier budget');
    expect(warnings).not.toContain('Peer failed during quorum');
    // F4: with nothing but cancelled rows the envelope names the run, not 'internal'.
    expect(failure.cause).toBe('cancelled');
    expect(failure.fix).toContain('wider tier');
  });

  it('gives the peer that settled on the abort the same row as the one that never settled', () => {
    const settledSource = makeSource('settled-abort', 1, 2, resolvesOnAbortOnly);
    const missingSource = makeSource('never', 1, 2, resolvesOnAbortOnly);
    const state: RecordState = {
      ...initialAbortAttribution(),
      runAborted: true,
      reports: new Map([
        [settledSource.name, seedReport(settledSource)],
        [missingSource.name, seedReport(missingSource)],
      ]),
      settled: new Set<string>(),
      successes: [],
      usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    const { warnings, debugs, logger } = collectors();

    // The orchestrator observes one abort settle; the sibling is still in flight
    // when the run unwinds, so the straggler pass itemizes it instead.
    recordSettled(state, { source: settledSource, result: err(cancelError('settled-abort')) }, logger);
    markCancelledStragglers(state);

    const settled = rosterRow(state.reports.get('settled-abort'));
    const missing = rosterRow(state.reports.get('never'));
    expect(settled).toEqual(missing);
    expect(settled).toEqual({
      status: 'cancelled',
      weight: 0,
      agreement: null,
      error: undefined,
      cause: undefined,
      note: QUORUM_MET_NOTE,
      timeoutMs: undefined,
    });
    // Not a peer failure, so the alertable warn stays clean and the record is debug.
    expect(warnings).not.toContain('Peer failed during quorum');
    expect(debugs).toContain('Peer cancelled during quorum');
  });

  it('keeps the wall in charge when it expires during the achieving evaluation', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'Paris'));
    const straggler = makeSource('straggler', 1, 2, resolvesOnAbortOnly);
    const { warnings, logger } = collectors();
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, straggler],
      arbiter: slowArbiter(250, { a: 0.9 }), // achieves, but answers after the wall
      thresholds: { 1: 2 },
      // Peer clock ≈ 170ms, wall 200ms, arbiter 250ms: the abort that ends the run
      // is the wall's, so the straggler keeps the failure shape the wall assigns
      // it (F3) rather than the cancelled row the early-abort would write.
      deadlineMs: 200,
      tierTimeoutMs: { 1: 5000 },
      arbiterTimeoutMs: 30,
      logger,
    });

    const result = (await useCase.execute({ prompt }))._unsafeUnwrap();

    expect(rosterRow(byName(result.sources, 'straggler'))).toEqual({
      status: 'error',
      weight: 2,
      agreement: null,
      error: 'No response recorded before the run ended',
      cause: 'deadline',
      note: undefined,
      timeoutMs: 200,
    });
    expect(warnings).not.toContain('Peer failed during quorum');
  });

  it('keeps a 401/429 that settles inside the abort window a peer failure with its own cause', () => {
    const { warnings, debugs, logger } = collectors();

    // F1: the abort window is not a licence to strip a peer-side failure of its
    // cause — only the abort-shaped error is a non-failure.
    const denied = recordCase(
      { runAborted: true, callerCancelled: true },
      'denied',
      new CredentialError('Authentication failed for "denied" (HTTP 401)'),
      logger,
    );
    expect(rosterRow(denied)).toEqual({
      status: 'unavailable',
      weight: 2,
      agreement: null,
      error: 'Authentication failed for "denied" (HTTP 401)',
      cause: 'credential',
      note: undefined,
      timeoutMs: undefined,
    });

    const limited = recordCase(
      { runAborted: true, callerCancelled: true },
      'limited',
      new PeerRateLimitError(1000),
      logger,
    );
    expect(rosterRow(limited)).toEqual({
      status: 'error',
      weight: 2,
      agreement: null,
      error: 'Rate limit exceeded. Retry after 1000ms',
      cause: 'rate_limited',
      note: undefined,
      timeoutMs: undefined,
    });

    const left = recordCase(
      { runAborted: true, callerCancelled: true },
      'left',
      cancelError('left'),
      logger,
    );
    expect(rosterRow(left)).toEqual({
      status: 'cancelled',
      weight: 0,
      agreement: null,
      error: undefined,
      cause: undefined,
      note: CALLER_NOTE,
      timeoutMs: undefined,
    });
    expect(warnings.filter((m) => m === 'Peer failed during quorum')).toHaveLength(2);
    expect(debugs).toEqual(['Peer cancelled during quorum']);
  });

  it('fails a peer whose clock expired while the same abort shape cancels its sibling', () => {
    const { warnings, debugs, logger } = collectors();

    const byRun = recordCase({ runAborted: true }, 'run-abort', cancelError('run-abort'), logger);
    expect(rosterRow(byRun)).toEqual({
      status: 'cancelled',
      weight: 0,
      agreement: null,
      error: undefined,
      cause: undefined,
      note: QUORUM_MET_NOTE,
      timeoutMs: undefined,
    });

    // The peer's own tier budget, and the global wall: each clock that expired is
    // the peer's failure, even though the request died on the same abort error.
    for (const flags of [
      { runAborted: true, tierClockFired: true },
      { runAborted: true, deadlineHit: true },
    ]) {
      const byClock = recordCase(flags, 'clock', cancelError('clock'), logger);
      expect(rosterRow(byClock)).toEqual({
        status: 'error',
        weight: 2,
        agreement: null,
        error: 'Request to "clock" was cancelled by the orchestrator',
        cause: 'deadline',
        note: undefined,
        timeoutMs: undefined,
      });
    }
    expect(warnings.filter((m) => m === 'Peer failed during quorum')).toHaveLength(2);
    expect(debugs).toEqual(['Peer cancelled during quorum']);
  });

  it('cancels the in-flight peers the run walked away from and only fails those the tier clock ran out on', () => {
    const slow = makeSource('slow', 1, 2, resolvesOnAbortOnly);
    const inflight = new Map<number, PeerSource>([[0, slow]]);

    // F2 at the mark site: the caller left, the tier's own budget never expired.
    const left = new Map([[slow.name, seedReport(slow)]]);
    markPendingOutage(inflight, left, {
      ...initialAbortAttribution(),
      runAborted: true,
      callerCancelled: true,
    });
    expect(rosterRow(left.get(slow.name))).toEqual({
      status: 'cancelled',
      weight: 0,
      agreement: null,
      error: undefined,
      cause: undefined,
      note: CALLER_NOTE,
      timeoutMs: undefined,
    });

    // The tier's budget expired: the same peer stays outage-shaped.
    const outage = new Map([[slow.name, seedReport(slow)]]);
    markPendingOutage(inflight, outage, {
      ...initialAbortAttribution(),
      runAborted: true,
      tierClockFired: true,
    });
    expect(rosterRow(outage.get(slow.name))).toEqual({
      status: 'error',
      weight: 2,
      agreement: null,
      error: 'tier budget elapsed — still in flight',
      cause: 'deadline',
      note: undefined,
      timeoutMs: undefined,
    });
  });

  it('leaves a row the run already settled to its own verdict when the tier clock runs out', () => {
    // The guard the two straggler passes already keep, at the tier-outage site:
    // a peer the orchestrator watched settle carries its own cause, so the clock
    // that merely stopped waiting for its sibling must not re-stamp it.
    const limited = makeSource('limited', 1, 2, answers('limited', 'x'));
    const report = seedReport(limited);
    const { logger } = collectors();
    recordSettled(
      {
        ...initialAbortAttribution(),
        runAborted: true,
        tierClockFired: true,
        reports: new Map([[limited.name, report]]),
        settled: new Set<string>(),
        successes: [],
        usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
      { source: limited, result: err(new PeerRateLimitError(1000)) },
      logger,
    );
    const inflight = new Map<number, PeerSource>([[0, limited]]);
    markPendingOutage(inflight, new Map([[limited.name, report]]), {
      ...initialAbortAttribution(),
      runAborted: true,
      tierClockFired: true,
      settled: new Set([limited.name]),
    });
    expect(rosterRow(report)).toEqual({
      status: 'error',
      weight: 2,
      agreement: null,
      error: 'Rate limit exceeded. Retry after 1000ms',
      cause: 'rate_limited',
      note: undefined,
      timeoutMs: undefined,
    });
  });

  it('never cancels at the early-abort site what the wall already killed', () => {
    const left = makeSource('left', 1, 2, resolvesOnAbortOnly);
    const inflight = new Map<number, PeerSource>([[0, left]]);

    const afterQuorum = new Map([[left.name, seedReport(left)]]);
    markPendingCancelled(inflight, afterQuorum, initialAbortAttribution());
    expect(rosterRow(afterQuorum.get(left.name))).toEqual({
      status: 'cancelled',
      weight: 0,
      agreement: null,
      error: undefined,
      cause: undefined,
      note: QUORUM_MET_NOTE,
      timeoutMs: undefined,
    });

    // F3: the wall expired during that same evaluation — the straggler keeps the
    // error shape, so the deadline stays visible to the caller.
    const duringWall = new Map([[left.name, seedReport(left)]]);
    markPendingCancelled(inflight, duringWall, {
      ...initialAbortAttribution(),
      runAborted: true,
      deadlineHit: true,
    });
    expect(rosterRow(duringWall.get(left.name))).toEqual({
      status: 'error',
      weight: 2,
      agreement: null,
      error: 'No response recorded before the run ended',
      cause: undefined,
      note: undefined,
      timeoutMs: undefined,
    });
  });

  it('pins the status/error/note/cause/weight combination for every SourceStatus', async () => {
    const answered = makeSource('answered', 1, 2, answers('answered', 'Paris'));
    const timedout = makeSource('timedout', 1, 2, async () =>
      err(new TimeoutError('Request to "timedout" was aborted', 250)),
    );
    const nokey = makeSource('nokey', 1, 2, answers('nokey', 'unused'), false);
    const self = makeSource('self', 1, 2, answers('self', 'unused'));
    const straggler = makeSource('straggler', 1, 2, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [answered, timedout, nokey, self, straggler],
      arbiter: makeArbiter([{ answered: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });

    const result = (await useCase.execute({ prompt, callerSource: 'self' }))._unsafeUnwrap();

    // ok: answered and was rated; failure slots empty, configured weight kept.
    expect(rosterRow(byName(result.sources, 'answered'))).toEqual({
      status: 'ok',
      weight: 2,
      agreement: 0.9,
      error: undefined,
      cause: undefined,
      note: undefined,
      timeoutMs: undefined,
    });
    // error (peer-side): failure slots filled, weight kept (leadFailure ranks by it).
    expect(rosterRow(byName(result.sources, 'timedout'))).toEqual({
      status: 'error',
      weight: 2,
      agreement: null,
      error: 'Request to "timedout" was aborted',
      cause: 'deadline',
      note: undefined,
      timeoutMs: 250,
    });
    // unavailable: never called for a caller-side reason — configured weight kept.
    expect(rosterRow(byName(result.sources, 'nokey'))).toEqual({
      status: 'unavailable',
      weight: 2,
      agreement: null,
      error: 'Credential not resolvable; source skipped',
      cause: 'credential',
      note: undefined,
      timeoutMs: undefined,
    });
    // skipped: excluded as a redundant peer — configured weight kept, no note.
    expect(rosterRow(byName(result.sources, 'self'))).toEqual({
      status: 'skipped',
      weight: 2,
      agreement: null,
      error: 'Skipped: excluded as a redundant peer for this request (callerSource/skipLocal)',
      cause: 'configuration',
      note: undefined,
      timeoutMs: undefined,
    });
    // cancelled: non-failure — reason in note, zero effective weight, no failure slots.
    expect(rosterRow(byName(result.sources, 'straggler'))).toEqual({
      status: 'cancelled',
      weight: 0,
      agreement: null,
      error: undefined,
      cause: undefined,
      note: QUORUM_MET_NOTE,
      timeoutMs: undefined,
    });
  });
});
