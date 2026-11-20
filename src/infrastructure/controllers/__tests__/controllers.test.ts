import { ok, err } from 'neverthrow';
import type { PeerResponse } from '../../../domain/entities/index.js';
import {
  PeerReviewController,
  QueryPeerController,
  CountTokensController,
  ListPeersController,
} from '../index.js';
import {
  PeerReviewQuorumUseCase,
  QueryPeerUseCase,
  ListPeersUseCase,
  CountTokensUseCase,
} from '../../../domain/use-cases/index.js';
import type { PeerSource } from '../../../domain/entities/index.js';
import { CredentialError, TransportError, TruncatedPeerAnswerError } from '../../../domain/errors/index.js';
import {
  makeSource as makeSourceWith,
  makeSource,
  makeArbiter,
  answers,
  peerResponse,
  resolvesOnAbortOnly,
} from '../../../domain/use-cases/__tests__/helpers.js';

function buildControllers(): {
  peerReview: PeerReviewController;
  queryPeer: QueryPeerController;
  listPeers: ListPeersController;
  countTokens: CountTokensController;
} {
  const a = makeSourceWith('a', 1, 2, answers('a', 'answer-a'), true, 'openai', 'gpt-a');
  const b = makeSourceWith('b', 1, 2, answers('b', 'answer-b'), true, 'anthropic', 'opus-x');
  const sources = [a, b];
  const quorum = new PeerReviewQuorumUseCase({
    sources,
    arbiter: makeArbiter([{ a: 0.9, b: 0.9 }]),
    thresholds: { 1: 4 },
    deadlineMs: 5000,
  });
  return {
    peerReview: new PeerReviewController(quorum),
    queryPeer: new QueryPeerController(new QueryPeerUseCase(sources, 5000)),
    listPeers: new ListPeersController(new ListPeersUseCase(sources)),
    countTokens: new CountTokensController(new CountTokensUseCase(sources)),
  };
}

describe('PeerReviewController', () => {
  it('returns the envelope with certaintyScore, quorum, and tokenUsage on valid input', async () => {
    const { peerReview } = buildControllers();
    const result = await peerReview.handle({ prompt: 'Is water wet?' });
    expect(result.success).toBe(true);
    expect(result.data?.response).toBe('CONSENSUS');
    expect(result.data?.certaintyScore).toBeGreaterThan(0);
    expect(result.data?.certaintyScore).toBeLessThanOrEqual(1);
    expect(result.data?.quorum.achieved).toBe(true);
    expect(result.data?.quorum.sources).toHaveLength(2);
    expect(result.data?.tokenUsage.total).toBeGreaterThan(0);
  });

  it('rejects an empty prompt with VALIDATION_ERROR', async () => {
    const { peerReview } = buildControllers();
    const result = await peerReview.handle({ prompt: '' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns callerAgreement when callerAnswer is supplied, omits the key otherwise', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const b = makeSource('b', 1, 2, answers('b', 'answer-b'));
    const quorum = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter: makeArbiter([{ a: 0.9, b: 0.9, caller: 0.7 }]),
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });
    const controller = new PeerReviewController(quorum);

    const withCaller = await controller.handle({ prompt: 'q', callerAnswer: 'my draft' });
    expect(withCaller.success).toBe(true);
    expect(withCaller.data?.callerAgreement).toBe(0.7);

    const without = await controller.handle({ prompt: 'q' });
    expect(without.success).toBe(true);
    expect(without.data !== undefined && 'callerAgreement' in without.data).toBe(false);
  });

  it('rejects an empty callerAnswer with VALIDATION_ERROR', async () => {
    const { peerReview } = buildControllers();
    const result = await peerReview.handle({ prompt: 'q', callerAnswer: '' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a client-supplied model/temperature override (strict schema)', async () => {
    const { peerReview } = buildControllers();
    const withModel = await peerReview.handle({ prompt: 'q', model: 'evil-model' });
    expect(withModel.success).toBe(false);
    expect(withModel.error?.code).toBe('VALIDATION_ERROR');
    const withTemp = await peerReview.handle({ prompt: 'q', temperature: 2 });
    expect(withTemp.success).toBe(false);
    expect(withTemp.error?.code).toBe('VALIDATION_ERROR');
  });

  it('parses callerSource and skips that source, itemizing it as "skipped"', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const b = makeSource('b', 1, 2, answers('b', 'answer-b'));
    const quorum = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter: makeArbiter([{ a: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = await new PeerReviewController(quorum).handle({
      prompt: 'q',
      callerSource: 'b',
    });
    expect(result.success).toBe(true);
    expect(b.calls).toHaveLength(0);
    expect(result.data?.quorum.sources.find((s) => s.name === 'b')?.status).toBe('skipped');
  });

  it('rejects an empty callerSource with VALIDATION_ERROR', async () => {
    const { peerReview } = buildControllers();
    const result = await peerReview.handle({ prompt: 'q', callerSource: '' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('QueryPeerController', () => {
  it('returns the reference-shaped payload on valid input', async () => {
    const { queryPeer } = buildControllers();
    const result = await queryPeer.handle({ prompt: 'hello', source: 'b' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      response: 'answer-b',
      model: 'b-model',
      source: 'b',
      finishReason: 'stop',
      tokenUsage: { prompt: 10, completion: 5, total: 15, cachedPrompt: 0 },
    });
  });

  it('maps an unknown source to VALIDATION_ERROR', async () => {
    const { queryPeer } = buildControllers();
    const result = await queryPeer.handle({ prompt: 'hello', source: 'ghost' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unexpected properties', async () => {
    const { queryPeer } = buildControllers();
    const result = await queryPeer.handle({ prompt: 'hello', model: 'x' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('ListPeersController', () => {
  it('lists sources and count', async () => {
    const { listPeers } = buildControllers();
    const result = await listPeers.handle(undefined);
    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(2);
    expect(result.data?.sources[0]?.available).toBe(true);
  });
});

describe('CountTokensController', () => {
  it('counts via the source adapter', async () => {
    const { countTokens } = buildControllers();
    const result = await countTokens.handle({ text: 'count me', source: 'a' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      totalTokens: 1,
      model: 'a-model',
      method: 'estimate',
      source: 'a',
    });
  });

  it('rejects empty text with VALIDATION_ERROR', async () => {
    const { countTokens } = buildControllers();
    const result = await countTokens.handle({ text: '' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('failure envelope forwarding (tasks 4, 5, 14)', () => {
  const prompt = 'Which transport is best for 500 km cargo, and why?';

  function refusedSource(name: string, weight: number, errno = 'ECONNREFUSED'): PeerSource {
    return makeSource(name, 1, weight, async () =>
      err(new TransportError('Network error: TypeError: fetch failed', name, errno)),
    );
  }

  function deniedSource(name: string, weight: number): PeerSource {
    return makeSource(name, 1, weight, async () =>
      err(new CredentialError(`Authentication failed for "${name}" (HTTP 401)`)),
    );
  }

  it('peer_review Err path carries cause, source, fix, and the roster (task 5)', async () => {
    const refused = refusedSource('refused', 1);
    const denied = deniedSource('denied', 2);
    const useCase = new PeerReviewQuorumUseCase({
      sources: [refused, denied],
      arbiter: makeArbiter([{ refused: 0.9, denied: 0.9 }]),
      thresholds: { 1: 5 },
      deadlineMs: 5000,
    });
    const controller = new PeerReviewController(useCase);
    const result = await controller.handle({ prompt });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXTERNAL_SERVICE_ERROR');
    expect(result.error?.message).toBe('No peer source produced a response');
    expect(result.error?.cause).toBe('credential'); // highest-weight failed source
    expect(result.error?.source).toBe('denied');
    expect(typeof result.error?.fix).toBe('string');
    expect(result.error?.fix).toContain('credential');
    expect(result.error?.detail).toContain('context.sources');
    const roster = result.error?.context?.sources as Array<Record<string, unknown>>;
    expect(roster).toHaveLength(2);
    expect(roster.find((s) => s.name === 'refused')?.cause).toBe('peer_unreachable');
    expect(roster.find((s) => s.name === 'refused')?.error).toContain('Network error');
    expect(roster.find((s) => s.name === 'denied')?.cause).toBe('credential');
  });

  it('validation failure names the field to fix and keeps code/message (task 5)', async () => {
    const useCase = new PeerReviewQuorumUseCase({
      sources: [makeSource('a', 1, 1, answers('a', 'x'))],
      arbiter: makeArbiter([{ a: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const result = await new PeerReviewController(useCase).handle({ prompt: '' });
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.cause).toBe('validation');
    expect(result.error?.fix).toContain('prompt');
  });

  it('a failed quorum explains each rated row and marks the unrated one at the boundary', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const b = makeSource('b', 1, 2, answers('b', 'answer-b'));
    const c = makeSource('c', 1, 1, answers('c', 'answer-c'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b, c],
      // c is never rated, on either attempt; b is rated without a reason.
      arbiter: makeArbiter([{ a: { agreement: 0.1, reason: 'Recommends the opposite.' }, b: 0.9 }]),
      thresholds: { 1: 5 },
      deadlineMs: 5000,
    });
    const result = await new PeerReviewController(useCase).handle({ prompt });
    expect(result.data?.quorum.achieved).toBe(false);
    expect(result.data?.response).toBe('');
    const rows = result.data?.quorum.sources ?? [];
    expect(rows.find((s) => s.name === 'a')).toMatchObject({ agreement: 0.1, reason: 'Recommends the opposite.' });
    const bRow = rows.find((s) => s.name === 'b');
    expect(bRow?.agreement).toBe(0.9);
    expect(bRow).not.toHaveProperty('reason'); // no reason given → no key, old shape
    expect(bRow).not.toHaveProperty('note');
    expect(rows.find((s) => s.name === 'c')).toMatchObject({
      status: 'ok',
      agreement: null,
      note: 'Unrated: the arbiter returned no rating for this source',
    });
  });

  it('achieved path keeps the pre-change key set at the boundary (task 5)', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const b = makeSource('b', 1, 2, answers('b', 'answer-b'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [a, b],
      arbiter: makeArbiter([{ a: 0.9, b: 0.9 }]),
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });
    const result = await new PeerReviewController(useCase).handle({ prompt });
    expect(Object.keys(result)).toEqual(['success', 'data']);
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.data ?? {}).sort()).toEqual([
      'certaintyScore',
      'quorum',
      'response',
      'tokenUsage',
    ]);
    expect(Object.keys(result.data?.quorum ?? {}).sort()).toEqual([
      'achieved',
      'agreeingWeight',
      'requiredWeight',
      'sources',
      'tier',
    ]);
  });

  it('query_peer unreachable carries cause and names the source (task 14)', async () => {
    const refused = refusedSource('refused', 1);
    const controller = new QueryPeerController(new QueryPeerUseCase([refused], 5000));
    const result = await controller.handle({ source: 'refused', prompt: 'ping' });
    expect(result.success).toBe(false);
    expect(result.error?.cause).toBe('peer_unreachable');
    expect(result.error?.source).toBe('refused');
    expect(result.error?.detail).toContain('ECONNREFUSED');
  });

  it('query_peer names the output ceiling instead of being masked by the caller ceiling', async () => {
    const base = makeSource('claude', 1, 1, answers('claude', 'unused'));
    const claude: PeerSource = {
      ...base,
      client: {
        ...base.client,
        complete: async () =>
          err(
            new TruncatedPeerAnswerError(
              'Peer stopped at max_tokens (finish_reason=max_tokens, completion=8192)',
              'claude',
              'max_tokens',
              8192,
            ),
          ),
      },
    };
    const controller = new QueryPeerController(new QueryPeerUseCase([claude], 5_000_000, 300_000), {
      deadlineMs: 280000,
      callerTimeoutMs: 30000,
      cause: 'configuration',
      fix: 'lower the deadline, or raise the tool-call timeout in the harness registration',
    });
    const result = await controller.handle({ source: 'claude', prompt: 'ping' });
    expect(result.success).toBe(false);
    // A specific cause survives the ceiling mismatch; only 'internal' is masked.
    expect(result.error?.cause).toBe('peer_truncated');
    expect(result.error?.fix).toContain('maxOutputTokens');
    expect(result.error?.source).toBe('claude');
  });

  it('query_peer is bounded by the smaller of deadline and declared ceiling (task 14)', async () => {
    const slow = makeSource('slow', 1, 1, resolvesOnAbortOnly);
    const useCase = new QueryPeerUseCase([slow], 5_000_000, 50);
    const start = Date.now();
    const result = await useCase.execute({ source: 'slow', prompt: 'ping' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.isErr()).toBe(true);
    expect(slow.calls[0]?.signal?.aborted).toBe(true);
  });

  it('count_tokens failure carries the same members (task 14)', async () => {
    const base = makeSource('failing', 1, 1, answers('failing', 'x'));
    const failing: PeerSource = {
      ...base,
      client: {
        ...base.client,
        countTokens: async () =>
          err(new TransportError('Network error: fetch failed', 'failing', 'ENOTFOUND')),
      },
    };
    const controller = new CountTokensController(new CountTokensUseCase([failing]));
    const result = await controller.handle({ source: 'failing', text: 'hello world' });
    expect(result.success).toBe(false);
    expect(result.error?.cause).toBe('peer_unreachable');
    expect(result.error?.source).toBe('failing');
    expect(result.error?.detail).toContain('ENOTFOUND');
  });

  it('every consulted source skipped reports a configuration fault, not an outage (task 4)', async () => {
    const me = makeSource('me', 1, 1, answers('me', 'x'));
    const useCase = new PeerReviewQuorumUseCase({
      sources: [me],
      arbiter: makeArbiter([{ me: 0.9 }]),
      thresholds: { 1: 2 },
      deadlineMs: 5000,
    });
    const controller = new PeerReviewController(useCase);
    const result = await controller.handle({ prompt, callerSource: 'me' });
    expect(result.error?.cause).toBe('configuration');
    expect(result.error?.fix).toContain('callerSource');
    expect((result.error?.context?.sources as Array<Record<string, unknown>>)[0]?.status).toBe('skipped');
  });

  it('credential mismatch is reported by list_peers while it holds (task 8)', () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'), true, 'openai', 'gpt-a');
    const useCase = new ListPeersUseCase([a], {
      deadlineMs: 280000,
      callerTimeoutMs: 30000,
      cause: 'configuration',
      fix: 'lower the deadline, or raise the tool-call timeout in the harness registration',
    });
    const listing = useCase.execute();
    expect(listing.count).toBe(1);
    expect(listing.callerCeiling?.cause).toBe('configuration');
    expect(listing.callerCeiling?.fix).toContain('harness registration');
    expect(listing.callerCeiling?.deadlineMs).toBe(280000);
    expect(listing.callerCeiling?.callerTimeoutMs).toBe(30000);
  });

  it('list_peers omits the ceiling warning when the pair is healthy (task 8)', () => {
    const a = makeSource('a', 1, 1, answers('a', 'x'), true, 'openai', 'gpt-a');
    const listing = new ListPeersUseCase([a]).execute();
    expect(listing.callerCeiling).toBeUndefined();
    expect('callerCeiling' in listing).toBe(false);
  });
});

describe('tokenUsage.cachedPrompt', () => {
  const usage = (promptTokens: number, cachedPromptTokens: number): PeerResponse['usage'] => ({
    promptTokens,
    cachedPromptTokens,
    completionTokens: 20,
    totalTokens: promptTokens + 20,
  });
  const reply = (source: string, text: string, cached: number): PeerResponse => ({
    ...peerResponse(source, text),
    usage: usage(1000, cached),
  });

  it('reports the cached prompt tokens of a query_peer call', async () => {
    const source = makeSource('s', 1, 1, async () => ok(reply('s', 'hi', 768)));
    const result = await new QueryPeerController(new QueryPeerUseCase([source], 5000)).handle({ prompt: 'q', source: 's' });
    expect(result.data?.tokenUsage).toEqual({ prompt: 1000, completion: 20, total: 1020, cachedPrompt: 768 });
  });

  it('sums cached prompt tokens across the peers and both arbiter calls of a peer_review run', async () => {
    const verdict = JSON.stringify({
      consensus: 'C',
      ratings: [
        { id: 'D1', agreement: 0.9 },
        { id: 'D2', agreement: 0.9 },
      ],
    });
    let arbiterCall = 0;
    const arbiter = makeSource('arbiter', 99, 1, async () => {
      arbiterCall += 1;
      return ok(arbiterCall === 1 ? reply('arbiter', 'not json', 0) : reply('arbiter', verdict, 900));
    });
    const quorum = new PeerReviewQuorumUseCase({
      sources: [
        makeSource('a', 1, 2, async () => ok(reply('a', 'x', 0))),
        makeSource('b', 1, 2, async () => ok(reply('b', 'x', 0))),
      ],
      arbiter,
      thresholds: { 1: 4 },
      deadlineMs: 5000,
    });
    const result = await new PeerReviewController(quorum).handle({ prompt: 'q' });
    expect(arbiterCall).toBe(2);
    expect(result.data?.tokenUsage.cachedPrompt).toBe(900);
    expect(result.data?.tokenUsage.prompt).toBe(4000);
  });

  it('is 0 when no provider reported cache data', async () => {
    const { peerReview } = buildControllers();
    expect((await peerReview.handle({ prompt: 'q' })).data?.tokenUsage.cachedPrompt).toBe(0);
  });
});
