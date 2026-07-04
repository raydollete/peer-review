import type { Result } from 'neverthrow';
import type { PeerRequest, PeerResponse, TokenCountResult } from '../entities/index.js';
import type { DomainError } from '../errors/index.js';

export interface IPeerClient {
  complete(request: PeerRequest): Promise<Result<PeerResponse, DomainError>>;
  countTokens(text: string): Promise<Result<TokenCountResult, DomainError>>;
}
