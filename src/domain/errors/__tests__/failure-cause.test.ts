import { ExternalServiceError } from '../../../shared/errors/index.js';
import {
  EmptyPeerAnswerError,
  MalformedResponseBodyError,
  PeerApiError,
  TruncatedPeerAnswerError,
  TransportError,
} from '../peer-errors.js';
import { causeOf, fixFor } from '../failure-cause.js';

const SERVICE = 'anthropic-claude-sonnet-5-5';

function truncated(stopReason: string, completionTokens: number): TruncatedPeerAnswerError {
  return new TruncatedPeerAnswerError(
    `Peer stopped at its output ceiling (stop_reason=${stopReason}, completion=${completionTokens})`,
    SERVICE,
    stopReason,
    completionTokens,
  );
}

describe('causeOf — unusable provider answers', () => {
  it('names the output-ceiling stop as peer_truncated', () => {
    expect(causeOf(truncated('max_tokens', 8192))).toBe('peer_truncated');
    expect(causeOf(truncated('length', 400))).toBe('peer_truncated');
  });

  it('reports a textless answer as a bad response', () => {
    const error = new EmptyPeerAnswerError(
      'Peer returned no usable text (stop_reason=refusal, completion=0)',
      SERVICE,
      'refusal',
      0,
    );
    expect(causeOf(error)).toBe('peer_bad_response');
  });

  it('classifies by subclass before the ExternalServiceError catch-all', () => {
    // Every one of these extends ExternalServiceError; only subclass identity
    // may decide the cause, and never the message text.
    expect(causeOf(truncated('max_tokens', 1))).not.toBe('internal');
    expect(causeOf(new ExternalServiceError('same words', SERVICE))).toBe('internal');
    expect(causeOf(new MalformedResponseBodyError('same words', SERVICE))).toBe(
      'peer_bad_response',
    );
    expect(causeOf(new PeerApiError('same words', 200, SERVICE))).toBe('peer_bad_response');
    expect(causeOf(new TransportError('same words', SERVICE, 'ECONNREFUSED'))).toBe(
      'peer_unreachable',
    );
  });

  it('keeps the provider stop signal and billed tokens as typed fields', () => {
    const error = truncated('max_tokens', 8192);
    expect(error.stopReason).toBe('max_tokens');
    expect(error.completionTokens).toBe(8192);
    expect(error.code).toBe('EXTERNAL_SERVICE_ERROR');
    expect(error.service).toBe(SERVICE);
  });

  it('points the operator at the output budget', () => {
    expect(fixFor('peer_truncated')).toContain('maxOutputTokens');
    expect(fixFor('peer_truncated')).toContain('max_tokens');
  });
});
