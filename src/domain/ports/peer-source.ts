import type { IPeerClient } from './peer-client.port.js';

/**
 * A configured peer source bound to its client. `apiType` is an opaque label
 * surfaced to callers; the domain never branches on it.
 */
export interface PeerSource {
  readonly name: string;
  readonly model: string;
  readonly apiType: string;
  readonly weight: number;
  readonly tier: number;
  readonly available: boolean;
  /** Served by the local inference backend; excluded when the caller is local
   * (PEER_REVIEW_SKIP_LOCAL) to avoid self-contention. */
  readonly local?: boolean | undefined;
  readonly client: IPeerClient;
}

/** Default source: lowest tier first, then highest weight. */
export function defaultSource(sources: readonly PeerSource[]): PeerSource | undefined {
  return [...sources].sort((a, b) => a.tier - b.tier || b.weight - a.weight)[0];
}
