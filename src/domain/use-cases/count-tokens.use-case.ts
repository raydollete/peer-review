import { err, type Result } from 'neverthrow';
import type { TokenCountResult } from '../entities/index.js';
import type { PeerSource } from '../ports/index.js';
import type { DomainError } from '../errors/index.js';
import { resolveSource } from './query-peer.use-case.js';

export interface CountTokensInput {
  readonly text: string;
  readonly source?: string | undefined;
}

export class CountTokensUseCase {
  constructor(private readonly sources: readonly PeerSource[]) {}

  async execute(
    input: CountTokensInput,
  ): Promise<Result<TokenCountResult & { readonly source: string }, DomainError>> {
    const source = resolveSource(this.sources, input.source);
    if (source.isErr()) {
      return err(source.error);
    }
    const result = await source.value.client.countTokens(input.text);
    return result.map((count) => ({ ...count, source: source.value.name }));
  }
}
