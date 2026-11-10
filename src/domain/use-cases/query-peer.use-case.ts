import { ok, err, type Result } from 'neverthrow';
import type { HistoryTurn, PeerResponse } from '../entities/index.js';
import { defaultSource, type PeerSource } from '../ports/index.js';
import { ConfigurationError, ValidationError, type DomainError } from '../errors/index.js';

export interface QueryPeerInput {
  readonly prompt: string;
  readonly history?: readonly HistoryTurn[] | undefined;
  readonly source?: string | undefined;
}

export class QueryPeerUseCase {
  constructor(
    private readonly sources: readonly PeerSource[],
    /** The global deadline: a source's own timeoutMs may exceed it. */
    private readonly deadlineMs: number,
    /** Declared MCP client tool-call ceiling: the single call is bounded by the
     * smaller of the two so an answer arrives before the caller abandons. */
    private readonly callerTimeoutMs?: number,
  ) {}

  async execute(
    input: QueryPeerInput,
    callerSignal?: AbortSignal,
  ): Promise<Result<PeerResponse, DomainError>> {
    const source = resolveSource(this.sources, input.source);
    if (source.isErr()) {
      return err(source.error);
    }
    const boundMs =
      this.callerTimeoutMs === undefined
        ? this.deadlineMs
        : Math.min(this.deadlineMs, this.callerTimeoutMs);
    const signals = [AbortSignal.timeout(boundMs)];
    if (callerSignal !== undefined) {
      signals.push(callerSignal);
    }
    return source.value.client.complete({
      prompt: input.prompt,
      history: input.history,
      signal: AbortSignal.any(signals),
    });
  }
}

export function resolveSource(
  sources: readonly PeerSource[],
  name: string | undefined,
): Result<PeerSource, DomainError> {
  if (name !== undefined) {
    const found = sources.find((s) => s.name === name);
    if (found === undefined) {
      return err(new ValidationError(`Unknown source: "${name}"`));
    }
    return ok(found);
  }
  const fallback = defaultSource(sources);
  if (fallback === undefined) {
    return err(new ConfigurationError('No peer sources configured'));
  }
  return ok(fallback);
}
