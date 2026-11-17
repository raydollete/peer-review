import {
  ConfigurationError,
  DomainError,
  ExternalServiceError,
} from '../../shared/errors/index.js';
import type { PeerReviewFailureCause } from './failure-cause.js';
import type { QuorumErrorContext } from '../entities/quorum-result.js';

export class PeerApiError extends DomainError {
  readonly code = 'PEER_API_ERROR';

  constructor(
    readonly message: string,
    readonly statusCode?: number | undefined,
    readonly service?: string | undefined,
  ) {
    super();
  }
}

export class PeerRateLimitError extends DomainError {
  readonly code = 'PEER_RATE_LIMIT';
  readonly message: string;

  constructor(readonly retryAfterMs?: number) {
    super();
    this.message =
      retryAfterMs !== undefined
        ? `Rate limit exceeded. Retry after ${retryAfterMs}ms`
        : 'Rate limit exceeded';
  }
}

/** A credential is rejected or unresolvable. `code` stays the wire class
 * `CONFIGURATION_ERROR` (401/403 → configuration error, provider-adapters spec)
 * while the subclass identity maps to cause `'credential'`. */
export class CredentialError extends ConfigurationError {
  constructor(override readonly message: string) {
    super(message);
  }
}

/** Transport-layer fetch/body-read failure with the unwrapped errno (`ECONNREFUSED`,
 * `ENOTFOUND`, …) as a typed field — display-only, never re-derived from message
 * text. Maps to cause `'peer_unreachable'`. */
export class TransportError extends ExternalServiceError {
  constructor(
    override readonly message: string,
    service: string,
    readonly errno?: string | undefined,
  ) {
    super(message, service);
  }
}

/** The orchestrator (caller) aborted while this call was in flight — honest
 * cancellation, never blamed on the source. Maps to cause `'deadline'`. */
export class CancellationError extends ExternalServiceError {
  constructor(override readonly message: string, service: string) {
    super(message, service);
  }
}

/** A source's tier time budget elapsed with the call still in flight. Maps to
 * cause `'deadline'`. */
export class TierBudgetElapsedError extends ExternalServiceError {
  constructor(override readonly message: string, service: string) {
    super(message, service);
  }
}

/** A fully-received body that is not valid JSON. Maps to `'peer_bad_response'`. */
export class MalformedResponseBodyError extends ExternalServiceError {
  constructor(override readonly message: string, service: string) {
    super(message, service);
  }
}

/** A provider reply that cannot be used as a vote: no answer text at all (a
 * thinking-only `max_tokens` body, a `refusal`, an empty completion). The
 * provider's stop signal and the completion tokens it billed are typed fields,
 * so the roster names the burn without re-deriving it from message text. Maps
 * to `'peer_bad_response'`. */
export class EmptyPeerAnswerError extends ExternalServiceError {
  constructor(
    override readonly message: string,
    service: string,
    readonly stopReason: string,
    readonly completionTokens: number,
  ) {
    super(message, service);
  }
}

/** A provider reply the model stopped at its own output ceiling (Anthropic
 * `max_tokens`, OpenAI `length`). Whether or not text came out, a half-written
 * answer must not carry quorum weight. Maps to `'peer_truncated'`, whose
 * operator fix is the source's output budget. */
export class TruncatedPeerAnswerError extends ExternalServiceError {
  constructor(
    override readonly message: string,
    service: string,
    readonly stopReason: string,
    readonly completionTokens: number,
  ) {
    super(message, service);
  }
}

/** The arbiter answered in prose so extraction failed after the one re-ask.
 * Maps to `'arbiter_malformed'`; any other arbiter error is `'arbiter_unavailable'`. */
export class ArbiterMalformedError extends ExternalServiceError {
  constructor(override readonly message: string, service: string) {
    super(message, service);
  }
}

/** A quorum-level failure that carries its already-computed wire fields so the
 * boundary never has to re-derive them: the top-level cause, the responsible
 * source, a redacted detail line, the operator fix, and the per-source roster. */
export class QuorumFailureError extends ExternalServiceError {
  override readonly cause: PeerReviewFailureCause;
  readonly source?: string | undefined;
  readonly detail?: string | undefined;
  readonly fix?: string | undefined;
  readonly context?: QuorumErrorContext | undefined;

  constructor(
    override readonly message: string,
    service: string,
    fields: {
      cause: PeerReviewFailureCause;
      source?: string | undefined;
      detail?: string | undefined;
      fix?: string | undefined;
      context?: QuorumErrorContext | undefined;
    },
  ) {
    super(message, service);
    this.cause = fields.cause;
    this.source = fields.source;
    this.detail = fields.detail;
    this.fix = fields.fix;
    this.context = fields.context;
  }
}
