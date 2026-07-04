import { ok, err, type Result } from 'neverthrow';
import type { PeerSource, IPeerClient } from '../../ports/index.js';
import type { PeerRequest, PeerResponse } from '../../entities/index.js';
import { PeerApiError } from '../../errors/index.js';
import { TimeoutError, type DomainError } from '../../../shared/errors/index.js';

export type CompleteFn = (request: PeerRequest) => Promise<Result<PeerResponse, DomainError>>;

export interface TestSource extends PeerSource {
  readonly calls: PeerRequest[];
}

export function peerResponse(source: string, text: string): PeerResponse {
  return {
    text,
    model: `${source}-model`,
    source,
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

export function makeSource(
  name: string,
  tier: number,
  weight: number,
  complete: CompleteFn,
  available = true,
): TestSource {
  const calls: PeerRequest[] = [];
  const client: IPeerClient = {
    complete: async (request) => {
      calls.push(request);
      return complete(request);
    },
    countTokens: async () =>
      ok({ totalTokens: 1, model: `${name}-model`, method: 'estimate' as const }),
  };
  return { name, model: `${name}-model`, apiType: 'generic', weight, tier, available, client, calls };
}

export function answers(name: string, text: string): CompleteFn {
  return async () => ok(peerResponse(name, text));
}

/** Resolves with a TimeoutError only once the request signal aborts. */
export const resolvesOnAbortOnly: CompleteFn = (request) =>
  new Promise((resolve) => {
    const fail = (): void => resolve(err(new TimeoutError('aborted', 1)));
    if (request.signal?.aborted === true) {
      fail();
      return;
    }
    request.signal?.addEventListener('abort', fail);
  });

export type ArbiterScript = Array<Record<string, number> | 'transport-error' | 'garbage'>;

/**
 * Arbiter whose i-th call follows the i-th script entry: a name→rating map
 * (returned as strict JSON), 'garbage' (non-JSON text), or 'transport-error'.
 * The last entry repeats once the script is exhausted.
 */
export function makeArbiter(script: ArbiterScript, consensus = 'CONSENSUS'): TestSource {
  let call = 0;
  const complete: CompleteFn = async () => {
    const entry = script[Math.min(call, script.length - 1)];
    call += 1;
    if (entry === 'transport-error') {
      return err(new PeerApiError('arbiter down', 500));
    }
    if (entry === 'garbage' || entry === undefined) {
      return ok(peerResponse('arbiter', 'I refuse to answer in JSON.'));
    }
    const ratings = Object.entries(entry).map(([name, agreement]) => ({ name, agreement }));
    return ok(peerResponse('arbiter', JSON.stringify({ consensus, ratings })));
  };
  return makeSource('arbiter', 99, 1, complete);
}
