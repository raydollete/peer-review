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
      return err(new TimeoutError(`Request to "${cfg.serviceName}" was aborted`, cfg.timeoutMs));
    }
    return err(new ExternalServiceError(`Network error: ${String(error)}`, cfg.serviceName));
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
      try {
        return ok((await response.json()) as unknown);
      } catch {
        return err(new ExternalServiceError('Response body is not valid JSON', cfg.serviceName));
      }
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
      if (Date.now() + delayMs >= deadline) {
        return err(mapStatusToError(response.status, cfg.serviceName));
      }
      state.rateLimitRetries += 1;
      await sleepFn(delayMs);
      continue;
    }

    return err(mapStatusToError(response.status, cfg.serviceName));
  }
}
