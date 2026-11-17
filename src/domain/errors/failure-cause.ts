import {
  ConfigurationError,
  ExternalServiceError,
  TimeoutError,
  ValidationError,
  type DomainError,
} from '../../shared/errors/index.js';
import {
  ArbiterMalformedError,
  CancellationError,
  CredentialError,
  EmptyPeerAnswerError,
  MalformedResponseBodyError,
  PeerApiError,
  PeerRateLimitError,
  QuorumFailureError,
  TierBudgetElapsedError,
  TruncatedPeerAnswerError,
  TransportError,
} from './peer-errors.js';

/**
 * The closed machine-cause vocabulary every failure envelope carries in
 * `error.cause`. Precedence: `error.code` stays the COARSE wire class existing
 * readers switch on (`VALIDATION_ERROR`, `CONFIGURATION_ERROR`, …); `error.cause`
 * is the ACTIONABLE reason and is what a repair guide reads. Readers MUST treat
 * an unrecognized cause as `'internal'`.
 *
 * The mapper is keyed off the DomainError subclasses only — never off message
 * text (provider-adapters spec). `'internal'` is the total fallback: any typed
 * error the mapper does not classify, and the bare `ExternalServiceError` left
 * for unexpected throws, land there.
 */
export type PeerReviewFailureCause =
  | 'peer_unreachable'
  | 'credential'
  | 'rate_limited'
  | 'peer_bad_response'
  /** The provider stopped the reply at its own output ceiling (`max_tokens` /
   * `length`), or produced no answer text at all inside it. The repair is the
   * source's output budget, not its model name or endpoint. */
  | 'peer_truncated'
  | 'arbiter_unavailable'
  | 'arbiter_malformed'
  | 'deadline'
  /** The run itself ended the request — early-abort after quorum, or the caller
   * cancelled. The gRPC `CANCELLED` analogue: a non-failure class, so a peer the
   * run no longer needed never reads as a peer defect. */
  | 'cancelled'
  | 'validation'
  | 'configuration'
  | 'internal';

/** Total mapper over the DomainError subclass lattice. Order matters: every
 * subclass before the base it extends. */
export function causeOf(error: DomainError): PeerReviewFailureCause {
  if (error instanceof QuorumFailureError) {
    return error.cause;
  }
  // Unusable provider answers are classified by subclass, never by message
  // text. Both sit above every other ExternalServiceError branch so a future
  // subclass of one of them cannot be swallowed by the catch-all below.
  if (error instanceof TruncatedPeerAnswerError) {
    return 'peer_truncated';
  }
  if (error instanceof EmptyPeerAnswerError) {
    return 'peer_bad_response';
  }
  if (error instanceof ValidationError) {
    return 'validation';
  }
  if (error instanceof CredentialError) {
    return 'credential';
  }
  if (error instanceof ConfigurationError) {
    return 'configuration';
  }
  if (error instanceof TimeoutError) {
    return 'deadline';
  }
  if (error instanceof CancellationError) {
    return 'deadline';
  }
  if (error instanceof TierBudgetElapsedError) {
    return 'deadline';
  }
  if (error instanceof PeerRateLimitError) {
    return 'rate_limited';
  }
  if (error instanceof PeerApiError) {
    return 'peer_bad_response';
  }
  if (error instanceof TransportError) {
    return 'peer_unreachable';
  }
  if (error instanceof MalformedResponseBodyError) {
    return 'peer_bad_response';
  }
  if (error instanceof ArbiterMalformedError) {
    return 'arbiter_malformed';
  }
  // Unmapped typed error (bare ExternalServiceError or anything future): the
  // catch-all, per the reference-architecture invariant.
  if (error instanceof ExternalServiceError) {
    return 'internal';
  }
  return 'internal';
}
const CAUSE_FIXES: Record<PeerReviewFailureCause, string> = {
  peer_unreachable:
    'Check the source baseUrl and network reachability from the server host, then retry',
  credential:
    'Set the credential env var or repair apiKeyCommand for the named source, then restart the server',
  peer_bad_response:
    'Check the model name and endpoint for the named source in peer-review.config.json, then retry once',
  rate_limited: 'Wait before retrying, or lower the weight/tier of this source in peer-review.config.json',
  arbiter_malformed:
    'Set jsonMode for the arbiter source or choose a JSON-reliable arbiter in peer-review.config.json',
  peer_truncated:
    'Raise maxOutputTokens for the named source (peer-review.config.json, or the peer policy in the app) — hidden reasoning is billed against max_tokens, so the output budget must exceed the model\'s thinking length; raise timeoutMs with it',
  arbiter_unavailable:
    'Check the arbiter source reachability and credentials in peer-review.config.json',
  deadline:
    'Raise PEER_REVIEW_DEADLINE_MS (staying strictly below PEER_REVIEW_CALLER_TIMEOUT_MS) or lower the per-source timeoutMs',
  cancelled:
    'Nothing failed: the run ended before these sources answered. Rerun with a wider tier or a faster roster in peer-review.config.json',
  validation: 'Correct the named argument and retry',
  configuration:
    'Fix peer-review.config.json or the named environment variable, then restart the server',
  internal:
    'Inspect the peer-review server stderr log for the correlationId in error.context; rerun with LOG_LEVEL=debug',
};

export function fixFor(cause: PeerReviewFailureCause): string {
  return CAUSE_FIXES[cause];
}
