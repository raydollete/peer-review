import type { PeerSource } from '../ports/index.js';

export interface PeerListing {
  readonly sources: ReadonlyArray<{
    readonly name: string;
    readonly apiType: string;
    readonly model: string;
    readonly weight: number;
    readonly tier: number;
    readonly available: boolean;
  }>;
  readonly count: number;
}

export class ListPeersUseCase {
  constructor(private readonly sources: readonly PeerSource[]) {}

  execute(): PeerListing {
    const sources = this.sources.map(({ name, apiType, model, weight, tier, available }) => ({
      name,
      apiType,
      model,
      weight,
      tier,
      available,
    }));
    return { sources, count: sources.length };
  }
}
