import type { PeerReviewFailureCause } from '../errors/failure-cause.js';
import type { TokenUsage } from './peer-response.js';

export type SourceStatus = 'ok' | 'error' | 'unavailable' | 'skipped' | 'cancelled';

/** The arbiter's preserved failure, recorded on the run state at evaluation
 * time (type alias, not interface, so it stays assignable to a wire record). */
export type ArbiterErrorRecord = {
  readonly code: string;
  readonly cause: PeerReviewFailureCause;
  readonly source: string;
  readonly detail: string;
};

/** The wire shape of an arbiter failure row: `{name, status, error}`. */
export type ArbiterReport = {
  readonly name: string;
  readonly status: 'failed';
  readonly error: {
    readonly code: string;
    readonly cause: PeerReviewFailureCause;
    readonly detail: string;
  };
};

/** The per-source roster plus the weight math, carried on every `success: false`
 * `peer_review` response in which at least one source was consulted — mirroring
 * the success path's `data.quorum` so one shape serves both paths. */
export type QuorumErrorContext = {
  readonly tier: number;
  readonly requiredWeight: number;
  readonly agreeingWeight: number;
  readonly arbiter?: ArbiterReport;
  readonly sources: readonly QuorumSourceReport[];
};

/** Freeze an `ArbiterErrorRecord` into its wire row. */
export function arbiterReport(record: ArbiterErrorRecord): ArbiterReport {
  return {
    name: record.source,
    status: 'failed',
    error: { code: record.code, cause: record.cause, detail: record.detail },
  };
}

export interface QuorumSourceReport {
  readonly name: string;
  readonly model: string;
  readonly status: SourceStatus;
  /** The source's EFFECTIVE contribution to this run: its configured weight, except
   * on a `cancelled` row, where it is 0 because a peer the run no longer needed
   * contributed no vote. `skipped` and `unavailable` keep the configured weight. */
  readonly weight: number;
  /** Arbiter agreement rating in [0, 1]; null when the source produced no rated response. */
  readonly agreement: number | null;
  /** Why a non-ok source FAILED — a failure slot, forbidden on a `cancelled` row
   * (whose reason lives in `note`). Absent when status is "ok" — a bare "error"
   * status is undiagnosable from the caller side, which only sees this envelope. */
  readonly error?: string | undefined;
  /** Machine cause of this source's failure, from the typed error that produced
   * it (never prose). Absent for ok/cancelled sources. */
  readonly cause?: PeerReviewFailureCause | undefined;
  /** The typed error's coarse wire class, kept beside the cause. */
  readonly code?: string | undefined;
  /** The service name a transport/external error named. */
  readonly service?: string | undefined;
  /** For a source that timed out: the budget it exceeded, so the caller can
   * tell which clock expired rather than parsing prose. */
  readonly timeoutMs?: number | undefined;
  /** Why a non-failure row is what it is: set on `cancelled` (the run or the
   * caller ended the request). A reader counting failures off a populated `error`
   * MUST NOT count these rows. */
  readonly note?: string | undefined;
}

export interface QuorumResult {
  readonly response: string;
  readonly certaintyScore: number;
  readonly achieved: boolean;
  readonly tier: number;
  readonly requiredWeight: number;
  readonly agreeingWeight: number;
  readonly arbiterFailed?: boolean;
  /** Set only when the quorum was not achieved and the synthesized consensus (or
   * representative fallback) prose has therefore been withheld: text no quorum
   * validated is unvalidated opinion, and returning it invites a caller to fold
   * un-quorum'd suggestions into its own reasoning. `response` stays a string —
   * it carries '' on a withheld result — so the shape is unchanged for clients
   * that read it unconditionally. Verdict metadata is always returned in full. */
  readonly responseWithheld?: true;
  /** Arbiter rating of the caller's own answer against the consensus, in [0, 1].
   * Present only when the call supplied a callerAnswer; null = supplied but unrated.
   * Carries zero quorum weight. */
  readonly callerAgreement?: number | null;
  readonly sources: readonly QuorumSourceReport[];
  /** Arbiter failure report on the arbiter-fallback success path: what its
   * name was, that it failed, and the typed cause — never a bare boolean.
   * Lives only on the success (`data.quorum`) path; the failure path carries
   * its own copy in `error.context.arbiter`, never the other way around. */
  readonly arbiter?: ArbiterReport;
  readonly usage: TokenUsage;
}
