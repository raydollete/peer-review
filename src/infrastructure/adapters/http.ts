import { ok, err, type Result } from 'neverthrow';
import {
  ConfigurationError,
  ExternalServiceError,
  TimeoutError,
  type DomainError,
} from '../../shared/errors/index.js';
import { PeerApiError, PeerRateLimitError } from '../../domain/errors/index.js';
import type { ICredentialProvider } from './credential-provider.js';

export interface HttpDeps {
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface PostJsonConfig {
  readonly url: string;
  readonly body: unknown;
  /** Builds auth headers from the resolved credential; the credential never leaves this call. */
  readonly headers: (credential: string) => Record<string, string>;
  readonly credentialProvider: ICredentialProvider;
  readonly serviceName: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

const MAX_RATE_LIMIT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const RETRYABLE_STATUSES = new Set([429, 503, 529]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves as soon as `signal` aborts (or immediately if already aborted), so a
 * backoff sleep can be raced against orchestrator cancellation instead of adding
 * non-abortable latency past the deadline. */
function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Honest attribution: an external (orchestrator) abort is cancellation, never a
 * source-attributed timeout — a healthy-but-contended source is not scapegoated. */
function cancelledError(serviceName: string): DomainError {
  return new ExternalServiceError(
    `Request to "${serviceName}" was cancelled by the orchestrator`,
    serviceName,
  );
}

/**
 * Wait out a retryable-status backoff, or bail. Returns an error to end the loop
 * (already cancelled, the sleep would breach the deadline, or cancellation fired
 * mid-sleep), or undefined to retry. The sleep is raced against the external
 * signal so a contended backend's 429/503 backoff adds no non-abortable latency.
 */
async function backoff(
  cfg: PostJsonConfig,
  sleepFn: (ms: number) => Promise<void>,
  delayMs: number,
  deadline: number,
  status: number,
): Promise<DomainError | undefined> {
  if (cfg.signal?.aborted === true) {
    return cancelledError(cfg.serviceName);
  }
  if (Date.now() + delayMs >= deadline) {
    return mapStatusToError(status, cfg.serviceName);
  }
  if (cfg.signal === undefined) {
    await sleepFn(delayMs);
    return undefined;
  }
  await Promise.race([sleepFn(delayMs), abortPromise(cfg.signal)]);
  return cfg.signal.aborted ? cancelledError(cfg.serviceName) : undefined;
}

/** Errors are mapped from HTTP status codes only — never from message text (design D6). */
export function mapStatusToError(status: number, serviceName: string): DomainError {
  if (status === 429) {
    return new PeerRateLimitError();
  }
  if (status === 401 || status === 403) {
    return new ConfigurationError(`Authentication failed for "${serviceName}" (HTTP ${status})`);
  }
  if (status === 404) {
    return new PeerApiError(`Model or endpoint not found for "${serviceName}"`, 404);
  }
  return new PeerApiError(`Peer API error from "${serviceName}" (HTTP ${status})`, status);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

interface AttemptState {
  credential: string;
  rateLimitRetries: number;
  authRetried: boolean;
}

async function refreshCredential(
  cfg: PostJsonConfig,
  state: AttemptState,
): Promise<DomainError | undefined> {
  cfg.credentialProvider.invalidate();
  const refreshed = await cfg.credentialProvider.getCredential();
  if (refreshed.isErr()) {
    return refreshed.error;
  }
  state.credential = refreshed.value;
  return undefined;
}

async function performFetch(
  cfg: PostJsonConfig,
  fetchFn: typeof fetch,
  credential: string,
  remainingMs: number,
): Promise<Result<Response, DomainError>> {
  try {
    const signals: AbortSignal[] = [AbortSignal.timeout(remainingMs)];
    if (cfg.signal !== undefined) {
      signals.push(cfg.signal);
    }
    const response = await fetchFn(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cfg.headers(credential) },
      body: JSON.stringify(cfg.body),
      signal: AbortSignal.any(signals),
    });
    return ok(response);
  } catch (error) {
    if (isAbortError(error)) {
      // Honest attribution: an external (orchestrator) signal aborting the call
      // is cancellation, NOT this source's own timeout. Only the per-request
      // AbortSignal.timeout firing scapegoats the source with a TimeoutError, so
      // a healthy-but-contended source the orchestrator moved on from is never
      // mislabeled as having timed out on its own.
      if (cfg.signal?.aborted === true) {
        return err(cancelledError(cfg.serviceName));
      }
      return err(new TimeoutError(`Request to "${cfg.serviceName}" was aborted`, cfg.timeoutMs));
    }
    return err(new ExternalServiceError(`Network error: ${String(error)}`, cfg.serviceName));
  }
}

/**
 * Read and parse a successful response body as two SEPARATE steps so a failure in
 * each is attributed to its true cause. The Response resolves as soon as headers
 * arrive; the body then streams — for a slow reasoning model, for minutes, behind
 * gateway keep-alive padding. A failure DURING that read is honestly attributed
 * exactly as performFetch does for the initial fetch: orchestrator cancellation
 * takes priority; then our own per-request deadline (checked signal-independently)
 * or an abort-shaped error is a timeout; anything else — a premature socket close
 * / proxy reset (undici `TypeError: terminated`) — is a transport error, NEVER a
 * malformed body. Only a genuine parse failure over a fully-received body is
 * "not valid JSON", so a healthy-but-slow source is never scapegoated.
 */
async function readJsonBody(
  response: Response,
  cfg: PostJsonConfig,
  deadline: number,
): Promise<Result<unknown, DomainError>> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (cfg.signal?.aborted === true) {
      return err(cancelledError(cfg.serviceName));
    }
    if (Date.now() >= deadline || isAbortError(error)) {
      return err(
        new TimeoutError(
          `Request to "${cfg.serviceName}" timed out while reading the response body`,
          cfg.timeoutMs,
        ),
      );
    }
    return err(
      new ExternalServiceError(`Network error reading response body: ${String(error)}`, cfg.serviceName),
    );
  }
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err(new ExternalServiceError('Response body is not valid JSON', cfg.serviceName));
  }
}

export async function postJson(
  cfg: PostJsonConfig,
  deps: HttpDeps = {},
): Promise<Result<unknown, DomainError>> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleepFn ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const deadline = Date.now() + cfg.timeoutMs;

  const initial = await cfg.credentialProvider.getCredential();
  if (initial.isErr()) {
    return err(initial.error);
  }
  const state: AttemptState = { credential: initial.value, rateLimitRetries: 0, authRetried: false };

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return err(new TimeoutError(`Request to "${cfg.serviceName}" timed out`, cfg.timeoutMs));
    }

    const attempt = await performFetch(cfg, fetchFn, state.credential, remaining);
    if (attempt.isErr()) {
      return err(attempt.error);
    }
    const response = attempt.value;

    if (response.ok) {
      return readJsonBody(response, cfg, deadline);
    }

    if (response.status === 401 && !state.authRetried) {
      state.authRetried = true;
      const failure = await refreshCredential(cfg, state);
      if (failure !== undefined) {
        return err(failure);
      }
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status) && state.rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      const delayMs = BACKOFF_BASE_MS * 2 ** state.rateLimitRetries * (1 + random());
      state.rateLimitRetries += 1;
      const failure = await backoff(cfg, sleepFn, delayMs, deadline, response.status);
      if (failure !== undefined) {
        return err(failure);
      }
      continue;
    }

    return err(mapStatusToError(response.status, cfg.serviceName));
  }
}
