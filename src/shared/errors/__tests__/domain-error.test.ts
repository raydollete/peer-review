import {
  ValidationError,
  ConfigurationError,
  TimeoutError,
  ExternalServiceError,
} from '../index.js';
import { PeerApiError, PeerRateLimitError } from '../../../domain/errors/index.js';

describe('domain errors', () => {
  const cases: Array<[Error & { toJSON(): { code: string; message: string } }, string]> = [
    [new ValidationError('bad input'), 'VALIDATION_ERROR'],
    [new ConfigurationError('missing key'), 'CONFIGURATION_ERROR'],
    [new TimeoutError('timed out', 120000), 'TIMEOUT_ERROR'],
    [new ExternalServiceError('boom', 'peer'), 'EXTERNAL_SERVICE_ERROR'],
    [new PeerApiError('upstream 500', 500), 'PEER_API_ERROR'],
    [new PeerRateLimitError(1000), 'PEER_RATE_LIMIT'],
  ];

  it.each(cases)('%s serializes to {code, message}', (error, code) => {
    const json = error.toJSON();
    expect(json.code).toBe(code);
    expect(typeof json.message).toBe('string');
    expect(json.message.length).toBeGreaterThan(0);
    expect(Object.keys(json).sort()).toEqual(['code', 'message']);
  });

  it('PeerApiError carries statusCode', () => {
    expect(new PeerApiError('not found', 404).statusCode).toBe(404);
  });

  it('PeerRateLimitError message without retryAfter', () => {
    expect(new PeerRateLimitError().message).toBe('Rate limit exceeded');
  });
});
