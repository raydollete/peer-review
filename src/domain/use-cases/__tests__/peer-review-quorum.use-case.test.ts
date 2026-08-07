import { err } from 'neverthrow';
import { PeerReviewQuorumUseCase } from '../peer-review-quorum.use-case.js';
import { ValidationError } from '../../errors/index.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import { makeSource, makeArbiter, answers, resolvesOnAbortOnly } from './helpers.js';

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
    expect(slowReport?.status).toBe('error');
    expect(slowReport?.agreement).toBeNull();
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
});
