import { DomainError } from '../../shared/errors/index.js';

export class PeerApiError extends DomainError {
  readonly code = 'PEER_API_ERROR';

  constructor(
    readonly message: string,
    readonly statusCode?: number,
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
