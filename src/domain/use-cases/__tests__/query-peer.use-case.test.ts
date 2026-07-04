import { QueryPeerUseCase } from '../query-peer.use-case.js';
import { ListPeersUseCase } from '../list-peers.use-case.js';
import { CountTokensUseCase } from '../count-tokens.use-case.js';
import { ValidationError } from '../../errors/index.js';
import { makeSource, answers } from './helpers.js';

const heavy1 = makeSource('heavy1', 1, 3, answers('heavy1', 'from heavy1'));
const light1 = makeSource('light1', 1, 1, answers('light1', 'from light1'));
const tier2 = makeSource('tier2', 2, 9, answers('tier2', 'from tier2'));
const sources = [tier2, light1, heavy1];

describe('QueryPeerUseCase', () => {
  it('defaults to the lowest-tier highest-weight source', async () => {
    const result = await new QueryPeerUseCase(sources).execute({ prompt: 'q' });
    expect(result._unsafeUnwrap().source).toBe('heavy1');
  });

  it('uses the named source when given', async () => {
    const result = await new QueryPeerUseCase(sources).execute({ prompt: 'q', source: 'tier2' });
    expect(result._unsafeUnwrap().source).toBe('tier2');
  });

  it('rejects an unknown source name with ValidationError', async () => {
    const result = await new QueryPeerUseCase(sources).execute({ prompt: 'q', source: 'nope' });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ValidationError);
  });
});

describe('ListPeersUseCase', () => {
  it('lists every source with availability and count', () => {
    const listing = new ListPeersUseCase(sources).execute();
    expect(listing.count).toBe(3);
    expect(listing.sources.map((s) => s.name)).toEqual(['tier2', 'light1', 'heavy1']);
    expect(listing.sources[0]).toEqual({
      name: 'tier2',
      apiType: 'generic',
      model: 'tier2-model',
      weight: 9,
      tier: 2,
      available: true,
    });
  });
});

describe('CountTokensUseCase', () => {
  it('routes to the named source adapter and tags the source', async () => {
    const result = await new CountTokensUseCase(sources).execute({
      text: 'hello',
      source: 'light1',
    });
    expect(result._unsafeUnwrap()).toEqual({
      totalTokens: 1,
      model: 'light1-model',
      method: 'estimate',
      source: 'light1',
    });
  });

  it('rejects an unknown source name', async () => {
    const result = await new CountTokensUseCase(sources).execute({ text: 't', source: 'nope' });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ValidationError);
  });
});
