import type { TokenUsage } from './peer-response.js';

export type SourceStatus = 'ok' | 'error' | 'unavailable';

export interface QuorumSourceReport {
  readonly name: string;
  readonly model: string;
  readonly status: SourceStatus;
  readonly weight: number;
  /** Arbiter agreement rating in [0, 1]; null when the source produced no rated response. */
  readonly agreement: number | null;
}

export interface QuorumResult {
  readonly response: string;
  readonly certaintyScore: number;
  readonly achieved: boolean;
  readonly tier: number;
  readonly requiredWeight: number;
  readonly agreeingWeight: number;
  readonly arbiterFailed?: boolean;
  /** Arbiter rating of the caller's own answer against the consensus, in [0, 1].
   * Present only when the call supplied a callerAnswer; null = supplied but unrated.
   * Carries zero quorum weight. */
  readonly callerAgreement?: number | null;
  readonly sources: readonly QuorumSourceReport[];
  readonly usage: TokenUsage;
}
