import { ok, err, type Result } from 'neverthrow';
import type { PeerSource, IPeerClient } from '../../ports/index.js';
import type { PeerRequest, PeerResponse } from '../../entities/index.js';
import { CancellationError, PeerApiError } from '../../errors/index.js';
import type { DomainError } from '../../../shared/errors/index.js';

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
  local = false,
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
  return {
    name,
    model: `${name}-model`,
    apiType: 'generic',
    weight,
    tier,
    available,
    local,
    client,
    calls,
  };
}

export function answers(name: string, text: string): CompleteFn {
  return async () => ok(peerResponse(name, text));
}

/**
 * Slow-but-alive: resolves SUCCESS after `ms`, independent of abort — the third
 * state (`resolvesOnAbortOnly` = dies on abort; `answers` = instant success)
 * that a contended-but-healthy backend occupies. The timer is unref'd so a run
 * that abandons this source (tier budget elapsed) never keeps the test process
 * alive waiting for it.
 */
export function resolvesAfterDelay(ms: number, text = 'slow answer'): CompleteFn {
  return () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(ok(peerResponse('slow', text)));
      }, ms);
      (timer as { unref?: () => void }).unref?.();
    });
}

/** Dies on the run's abort with the REAL adapter error — `CancellationError` as
 * produced by src/infrastructure/adapters/http.ts — not a stand-in: an
 * implementation steered by the wrong error shape would pass on a bare
 * `ExternalServiceError` and still misreport in production. Executor form on
 * purpose: the project's `lib` is ES2022, which has no `Promise.withResolvers`
 * type, and this file is typechecked (test files are excluded). */
export const resolvesOnAbortOnly: CompleteFn = (request) =>
  new Promise((resolve) => {
    const message = 'Request to "peer" was cancelled by the orchestrator';
    const fail = (): void => resolve(err(new CancellationError(message, 'peer')));
    if (request.signal?.aborted === true) {
      fail();
      return;
    }
    request.signal?.addEventListener('abort', fail);
  });

/** Arbiter that answers `ratings` after `ms`, ignoring abort — a slow evaluation
 * that the peer signal (deadline or tier budget) can fire during. */
export function slowArbiter(ms: number, ratings: Record<string, number>): TestSource {
  return makeSource('arbiter', 99, 1, () =>
    new Promise((resolve) => {
      setTimeout(() => {
        const body = Object.entries(ratings).map(([name, agreement]) => ({ name, agreement }));
        const consensus = { consensus: 'CONSENSUS', ratings: body };
        resolve(ok(peerResponse('arbiter', JSON.stringify(consensus))));
      }, ms);
    }),
  );
}

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
