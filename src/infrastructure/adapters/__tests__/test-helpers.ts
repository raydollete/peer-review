import { ok, err, type Result } from 'neverthrow';
import type { ICredentialProvider } from '../credential-provider.js';
import { ConfigurationError, type DomainError } from '../../../shared/errors/index.js';
import type { HttpDeps } from '../http.js';

export class StubCredentialProvider implements ICredentialProvider {
  invalidateCalls = 0;
  private readonly values: string[];

  constructor(...values: string[]) {
    this.values = values.length > 0 ? values : ['test-key'];
  }

  async getCredential(): Promise<Result<string, DomainError>> {
    const value = this.values.length > 1 ? this.values.shift() : this.values[0];
    if (value === undefined) {
      return err(new ConfigurationError('no credential'));
    }
    return ok(value);
  }

  invalidate(): void {
    this.invalidateCalls += 1;
  }
}

export class FailingCredentialProvider implements ICredentialProvider {
  async getCredential(): Promise<Result<string, DomainError>> {
    return err(new ConfigurationError('credential unavailable'));
  }

  invalidate(): void {
    // nothing cached
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Deps with an instant sleep and deterministic jitter so retry tests run fast. */
export function instantDeps(fetchFn: typeof fetch): HttpDeps {
  return {
    fetchFn,
    sleepFn: async () => undefined,
    random: () => 0,
  };
}
