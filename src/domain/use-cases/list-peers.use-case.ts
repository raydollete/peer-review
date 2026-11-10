import type { PeerSource } from '../ports/index.js';

/** The declared caller ceiling when it no longer sits strictly above the
 * server deadline — the mismatch is reported to callers while it holds. */
export type CallerCeiling = {
  readonly deadlineMs: number;
  readonly callerTimeoutMs: number;
  readonly cause: 'configuration';
  readonly fix: string;
};

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
  /** Present only while the deadline sits at or above the declared ceiling:
   * the caller abandons the call and reports only its own generic timeout, so
   * no verdict anyone computed is read. */
  readonly callerCeiling?: CallerCeiling;
}

export class ListPeersUseCase {
  constructor(
    private readonly sources: readonly PeerSource[],
    private readonly callerCeiling?: CallerCeiling,
  ) {}

  execute(): PeerListing {
    const sources = this.sources.map(({ name, apiType, model, weight, tier, available }) => ({
      name,
      apiType,
      model,
      weight,
      tier,
      available,
    }));
    return {
      sources,
      count: sources.length,
      ...(this.callerCeiling !== undefined ? { callerCeiling: this.callerCeiling } : {}),
    };
  }
}
