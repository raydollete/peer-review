import { ok, err, type Result } from 'neverthrow';
import { PeerReviewQuorumUseCase } from '../peer-review-quorum.use-case.js';
import { ValidationError } from '../../errors/index.js';
import { ExternalServiceError, TimeoutError, type DomainError } from '../../../shared/errors/index.js';
import type { PeerResponse } from '../../entities/index.js';
import {
  makeSource,
  makeArbiter,
  answers,
  peerResponse,
  resolvesOnAbortOnly,
  resolvesAfterDelay,
} from './helpers.js';

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

    expect(result.sources.find((s) => s.name === 'slow')?.error).toBeDefined();
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

  it('deadline mid-fan-out returns the accumulated partial result', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'fast answer'));
    const b = makeSource('b', 1, 2, resolvesOnAbortOnly);
    const arbiter = makeArbiter([{ a: 0.9 }]);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 50,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(result.achieved).toBe(false);
    expect(result.certaintyScore).toBe(0);
    // Quorum not achieved, so the prose is withheld: '' plus the signal. The
    // partial result is still fully transcribable from the metadata below.
    expect(result.response).toBe('');
    expect(result.responseWithheld).toBe(true);
    expect(result.sources.find((s) => s.name === 'a')?.status).toBe('ok');
    expect(result.sources.find((s) => s.name === 'b')?.status).toBe('error');
    expect(arbiter.calls).toHaveLength(0);
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
    expect(slowReport?.error).toBe('Cancelled: quorum was met before this source responded');
  });

  // ── stragglers while the arbiter is evaluating ─────────────────────────────

  /** Arbiter that answers `ratings` after `ms`, ignoring abort — a slow evaluation
   * that the peer signal (deadline or tier budget) can fire during. */
  function slowArbiter(ms: number, ratings: Record<string, number>) {
    return makeSource('arbiter', 99, 1, () =>
      new Promise((resolve) => {
        setTimeout(() => {
          const body = Object.entries(ratings).map(([name, agreement]) => ({ name, agreement }));
          resolve(ok(peerResponse('arbiter', JSON.stringify({ consensus: 'CONSENSUS', ratings: body }))));
        }, ms);
      }),
    );
  }

  it('records a peer that settles during an achieving evaluation instead of cancelling it', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'yes'));
    const late = makeSource('late', 1, 1, resolvesAfterDelay(20));
    const never = makeSource('never', 1, 1, resolvesOnAbortOnly);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, late, never],
      arbiter: slowArbiter(80, { a: 0.9 }),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
      tierTimeoutMs: { 1: 5000 },
      arbiterTimeoutMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    expect(result.achieved).toBe(true);
    const lateReport = result.sources.find((s) => s.name === 'late');
    expect(lateReport?.status).toBe('ok');
    expect(lateReport?.agreement).toBeNull(); // answered after the rating, so unrated
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
      tierTimeoutMs: { 1: 5000 },
      arbiterTimeoutMs: 5000,
      logger: { warn: (msg: string) => { warnings.push(msg); } },
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    const report = result.sources.find((s) => s.name === 'straggler');
    expect(report?.status).toBe('error');
    expect(report?.error).toBe('No response recorded before the run ended');
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
      arbiterTimeoutMs: 5000,
    });

    const result = (await useCase.execute({ prompt: 'q' }))._unsafeUnwrap();

    const report = result.sources.find((s) => s.name === 'straggler');
    expect(report?.status).toBe('error');
    expect(report?.error).toContain('tier budget elapsed — still in flight');
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
    // Stale ratings remain itemized for transparency.
    expect(result.sources.find((s) => s.name === 'a')?.agreement).toBe(0.9);
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
    expect(arbiter.calls[0]?.prompt).toContain('MY-SECRET-DRAFT');
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
              ratings: [
                { name: 'a', agreement: 1 },
                { name: 'c', agreement: 1 },
              ],
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
