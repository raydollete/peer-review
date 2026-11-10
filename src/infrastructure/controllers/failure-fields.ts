import { ExternalServiceError, TimeoutError, type DomainError } from '../../shared/errors/index.js';
import {
  ArbiterMalformedError,
  CancellationError,
  MalformedResponseBodyError,
  PeerApiError,
  PeerRateLimitError,
  QuorumFailureError,
  TierBudgetElapsedError,
  TransportError,
  causeOf,
  fixFor,
} from '../../domain/errors/index.js';
import type { McpToolErrorFields } from '../../shared/types/index.js';
import type { CallerCeiling } from '../../domain/use-cases/index.js';

/**
 * Build the additive failure members from typed-error fields plus the fixed
 * table only — never provider body text, headers, or credential material
 * (design invariants). `code`/`message` stay as they are; these ride beside them.
 */
export function failureFields(
  error: DomainError,
  callerCeiling?: CallerCeiling,
): McpToolErrorFields {
  const cause = causeOf(error);
  const source = failureSource(error);
  const detail = failureDetail(error);
  let fix = error instanceof QuorumFailureError ? (error.fix ?? fixFor(cause)) : fixFor(cause);
  let wireCause = cause;
  if (callerCeiling !== undefined) {
    // The declared caller ceiling is misconfigured: surface it on every failure
    // envelope while it holds. A failure with no specific cause is attributed to
    // the mismatch; a specific cause is kept and the ceiling fix rides along.
    if (cause === 'internal') {
      wireCause = 'configuration';
    }
    fix = `${callerCeiling.fix}. ${fix}`;
  }
  return {
    cause: wireCause,
    ...(source !== undefined ? { source } : {}),
    ...(detail !== undefined ? { detail } : {}),
    fix,
    ...(error instanceof QuorumFailureError && error.context !== undefined
      ? { context: { ...error.context } }
      : {}),
  };
}

function failureSource(error: DomainError): string | undefined {
  if (error instanceof QuorumFailureError && error.source !== undefined) {
    return error.source;
  }
  if (error instanceof ExternalServiceError) {
    return error.service;
  }
  if (error instanceof PeerApiError) {
    return error.service;
  }
  return undefined;
}

/** One provider-agnostic line from typed fields only (status, errno, timeout). */
function failureDetail(error: DomainError): string | undefined {
  if (error instanceof QuorumFailureError) {
    return error.detail;
  }
  if (error instanceof TransportError) {
    const what = error.errno !== undefined ? error.errno : 'transport failure';
    return `${what} contacting ${error.service}`;
  }
  if (error instanceof MalformedResponseBodyError) {
    return `response body from ${error.service} is not valid JSON`;
  }
  if (error instanceof CancellationError) {
    return `${error.service} was cancelled by the orchestrator`;
  }
  if (error instanceof TierBudgetElapsedError) {
    return `${error.service} did not finish inside the tier time budget`;
  }
  if (error instanceof ArbiterMalformedError) {
    return 'arbiter reply failed JSON extraction after one re-ask';
  }
  if (error instanceof TimeoutError) {
    return `timed out after ${error.timeoutMs}ms`;
  }
  if (error instanceof PeerRateLimitError) {
    return 'rate limited by the service';
  }
  if (error instanceof PeerApiError) {
    const from = error.service !== undefined ? ` from ${error.service}` : '';
    return error.statusCode !== undefined ? `HTTP ${error.statusCode}${from}` : `peer API error${from}`;
  }
  return undefined;
}
