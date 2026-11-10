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
  MalformedResponseBodyError,
  PeerApiError,
  PeerRateLimitError,
  QuorumFailureError,
  TierBudgetElapsedError,
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
  | 'arbiter_unavailable'
  | 'arbiter_malformed'
  | 'deadline'
  | 'validation'
  | 'configuration'
  | 'internal';

/** Total mapper over the DomainError subclass lattice. Order matters: every
 * subclass before the base it extends. */
export function causeOf(error: DomainError): PeerReviewFailureCause {
  if (error instanceof QuorumFailureError) {
    return error.cause;
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
  arbiter_unavailable:
    'Check the arbiter source reachability and credentials in peer-review.config.json',
  deadline:
    'Raise PEER_REVIEW_DEADLINE_MS (staying strictly below PEER_REVIEW_CALLER_TIMEOUT_MS) or lower the per-source timeoutMs',
  validation: 'Correct the named argument and retry',
  configuration:
    'Fix peer-review.config.json or the named environment variable, then restart the server',
  internal:
    'Inspect the peer-review server stderr log for the correlationId in error.context; rerun with LOG_LEVEL=debug',
};

export function fixFor(cause: PeerReviewFailureCause): string {
  return CAUSE_FIXES[cause];
}
