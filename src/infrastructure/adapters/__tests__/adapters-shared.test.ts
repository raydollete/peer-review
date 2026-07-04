import { jest } from '@jest/globals';
import { postJson } from '../http.js';
import { createAdapter } from '../adapter.factory.js';
import { OpenAiCompatAdapter } from '../openai-compat.adapter.js';
import { AnthropicCompatAdapter } from '../anthropic-compat.adapter.js';
import {
  ConfigurationError,
  TimeoutError,
  ExternalServiceError,
} from '../../../shared/errors/index.js';
import { PeerApiError, PeerRateLimitError } from '../../../domain/errors/index.js';
import {
  StubCredentialProvider,
  FailingCredentialProvider,
  jsonResponse,
  instantDeps,
} from './test-helpers.js';

function call(
  fetchFn: typeof fetch,
  provider = new StubCredentialProvider('key-1'),
  timeoutMs = 5000,
  signal?: AbortSignal,
): ReturnType<typeof postJson> {
  return postJson(
    {
      url: 'https://api.example.com/endpoint',
      body: { q: 1 },
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
      credentialProvider: provider,
      serviceName: 'test-source',
      timeoutMs,
      signal,
    },
    instantDeps(fetchFn),
  );
}

describe('shared adapter HTTP behavior', () => {
  it.each([
    [429, PeerRateLimitError],
    [401, ConfigurationError],
    [403, ConfigurationError],
    [404, PeerApiError],
    [500, PeerApiError],
    [502, PeerApiError],
  ])('maps HTTP %i to %p', async (status, errorClass) => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, status));
    const result = await call(fetchMock);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(errorClass);
  });

  it('carries the status code on PeerApiError', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404));
    const error = (await call(fetchMock))._unsafeUnwrapErr() as PeerApiError;
    expect(error.statusCode).toBe(404);
  });

  it.each([429, 503, 529])('retries HTTP %i at most twice (3 fetches total)', async (status) => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, status));
    await call(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a transient 503', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ fine: true }));
    const result = await call(fetchMock);
    expect(result._unsafeUnwrap()).toEqual({ fine: true });
  });

  it('on 401: invalidates credential, re-mints, retries once, and succeeds', async () => {
    const provider = new StubCredentialProvider('stale-key', 'fresh-key');
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await call(fetchMock, provider);
    expect(result._unsafeUnwrap()).toEqual({ ok: true });
    expect(provider.invalidateCalls).toBe(1);
    const secondHeaders = fetchMock.mock.calls[1]![1]?.headers as Record<string, string>;
    expect(secondHeaders['authorization']).toBe('Bearer fresh-key');
  });

  it('on persistent 401: returns ConfigurationError after exactly one re-mint', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    const provider = new StubCredentialProvider('k1', 'k2');
    const result = await call(fetchMock, provider);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ConfigurationError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry 403', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 403));
    const result = await call(fetchMock);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ConfigurationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the credential error without calling fetch when resolution fails', async () => {
    const fetchMock = jest.fn<typeof fetch>();
    const result = await call(fetchMock, new FailingCredentialProvider() as never);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an aborted request to TimeoutError', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const fail = (): void =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted === true) {
          fail();
          return;
        }
        init?.signal?.addEventListener('abort', fail);
      });
    });
    const controller = new AbortController();
    const pending = call(fetchMock, undefined, 5000, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(TimeoutError);
  });

  it('maps a per-source timeout to TimeoutError', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
        });
      });
    });
    const result = await call(fetchMock, undefined, 20);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(TimeoutError);
  });

  it('maps network failure to ExternalServiceError', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const result = await call(fetchMock);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ExternalServiceError);
  });
});

describe('adapter factory', () => {
  const limits = { timeoutMs: 1000, maxOutputTokens: 100 };
  const provider = new StubCredentialProvider();

  it('builds an OpenAI-compat adapter for apiType openai', () => {
    const adapter = createAdapter(
      {
        name: 's',
        apiType: 'openai',
        baseUrl: 'https://x.example',
        model: 'm',
        apiKeyEnv: 'K',
        weight: 1,
        tier: 1,
      },
      limits,
      provider,
    );
    expect(adapter).toBeInstanceOf(OpenAiCompatAdapter);
  });

  it('builds an Anthropic-compat adapter for apiType anthropic', () => {
    const adapter = createAdapter(
      {
        name: 's',
        apiType: 'anthropic',
        baseUrl: 'https://x.example',
        model: 'm',
        apiKeyEnv: 'K',
        weight: 1,
        tier: 1,
      },
      limits,
      provider,
    );
    expect(adapter).toBeInstanceOf(AnthropicCompatAdapter);
  });
});
