import {
  PeerReviewController,
  QueryPeerController,
  ListPeersController,
  CountTokensController,
} from '../index.js';
import {
  PeerReviewQuorumUseCase,
  QueryPeerUseCase,
  ListPeersUseCase,
  CountTokensUseCase,
} from '../../../domain/use-cases/index.js';
import {
  makeSource,
  makeArbiter,
  answers,
} from '../../../domain/use-cases/__tests__/helpers.js';

function buildControllers(): {
  peerReview: PeerReviewController;
  queryPeer: QueryPeerController;
  listPeers: ListPeersController;
  countTokens: CountTokensController;
} {
  const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
  const b = makeSource('b', 1, 2, answers('b', 'answer-b'));
  const sources = [a, b];
  const quorum = new PeerReviewQuorumUseCase({
    sources,
    arbiter: makeArbiter([{ a: 0.9, b: 0.9 }]),
    thresholds: { 1: 4 },
    deadlineMs: 5000,
  });
  return {
    peerReview: new PeerReviewController(quorum),
    queryPeer: new QueryPeerController(new QueryPeerUseCase(sources)),
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

  it('rejects a client-supplied model/temperature override (strict schema)', async () => {
    const { peerReview } = buildControllers();
    const withModel = await peerReview.handle({ prompt: 'q', model: 'evil-model' });
    expect(withModel.success).toBe(false);
    expect(withModel.error?.code).toBe('VALIDATION_ERROR');
    const withTemp = await peerReview.handle({ prompt: 'q', temperature: 2 });
    expect(withTemp.success).toBe(false);
    expect(withTemp.error?.code).toBe('VALIDATION_ERROR');
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
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
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
