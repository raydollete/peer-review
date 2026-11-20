import { jest } from '@jest/globals';
import { OpenAiCompatAdapter, type OpenAiCompatAdapterConfig } from '../openai-compat.adapter.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import {
  causeOf,
  EmptyPeerAnswerError,
  PeerApiError,
  PeerRateLimitError,
  TruncatedPeerAnswerError,
} from '../../../domain/errors/index.js';
import { StubCredentialProvider, jsonResponse, instantDeps } from './test-helpers.js';

const successFixture = {
  id: 'chatcmpl-123',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Paris is the capital of France.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
};

function makeAdapter(
  fetchFn: typeof fetch,
  logger?: { warn: (message: string, context?: Record<string, unknown>) => void },
  overrides: Partial<Pick<OpenAiCompatAdapterConfig, 'jsonMode'>> = {},
): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter(
    {
      sourceName: 'gpt-large',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-x',
      timeoutMs: 5000,
      maxOutputTokens: 1024,
      credentialProvider: new StubCredentialProvider('sk-test'),
      ...(logger !== undefined ? { logger } : {}),
      ...overrides,
    },
    instantDeps(fetchFn),
  );
}

function completionFixture(
  message: Record<string, unknown>,
  finishReason = 'stop',
): Record<string, unknown> {
  return {
    id: 'chatcmpl-r1',
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 900, total_tokens: 910 },
  };
}

describe('OpenAiCompatAdapter', () => {
  it('posts to /chat/completions with bearer auth and normalizes the response', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
    const adapter = makeAdapter(fetchMock);

    const result = await adapter.complete({
      prompt: 'What is the capital of France?',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'model', content: 'hello' },
      ],
      systemInstruction: 'be terse',
      temperature: 0,
    });

    const response = result._unsafeUnwrap();
    expect(response.text).toBe('Paris is the capital of France.');
    expect(response.finishReason).toBe('stop');
    expect(response.source).toBe('gpt-large');
    expect(response.model).toBe('model-x');
    expect(response.usage).toEqual({ promptTokens: 12, cachedPromptTokens: 0, completionTokens: 8, totalTokens: 20 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('model-x');
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'What is the capital of France?' },
    ]);
  });

  it('omits temperature when not set (provider default)', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
    await makeAdapter(fetchMock).complete({ prompt: 'q' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect('temperature' in body).toBe(false);
  });

  it('sends response_format json_object when jsonMode is on and the request asks for json', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
    await makeAdapter(fetchMock, undefined, { jsonMode: true }).complete({
      prompt: 'q',
      responseFormat: 'json',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format when jsonMode is on but the request carries no hint (peer call)', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
    await makeAdapter(fetchMock, undefined, { jsonMode: true }).complete({ prompt: 'q' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect('response_format' in body).toBe(false);
  });

  it('omits response_format when the request asks for json but jsonMode is off', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
    await makeAdapter(fetchMock).complete({ prompt: 'q', responseFormat: 'json' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect('response_format' in body).toBe(false);
  });

  it('retries 429 twice with backoff then returns PeerRateLimitError', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { message: 'rate limited' } }, 429));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(PeerRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps 500 to PeerApiError without retry', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(PeerApiError);
    expect((error as PeerApiError).statusCode).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a malformed 200 body to ExternalServiceError', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ unexpected: 'shape' }));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ExternalServiceError);
  });

  it('strips think blocks containing braces from content', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        completionFixture({
          role: 'assistant',
          content: '<think>maybe {"draft": 1} then {x}</think>\nUse awk.',
        }),
      ),
    );
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Use awk.');
  });

  it('trims leading whitespace left by gateway think-stripping', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(completionFixture({ role: 'assistant', content: '\n\nUse awk.' })),
    );
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Use awk.');
  });

  it('falls back to reasoning_content when content is null', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        completionFixture({ role: 'assistant', content: null, reasoning_content: 'Use awk.' }),
      ),
    );
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Use awk.');
  });

  it('accepts a message with no content key at all', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(completionFixture({ role: 'assistant', reasoning_content: 'Use awk.' })),
    );
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Use awk.');
  });

  it('tolerates object-shaped reasoning fields', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        completionFixture({
          role: 'assistant',
          content: 'Use awk.',
          reasoning: { tokens: 512 },
        }),
      ),
    );
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Use awk.');
  });

  it('errors on unclosed think exhausting the reply (finish_reason=length)', async () => {
    const warn = jest.fn();
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        completionFixture(
          { role: 'assistant', content: '<think>ran out of budget while reasoning' },
          'length',
        ),
      ),
    );
    const result = await makeAdapter(fetchMock, { warn }).complete({ prompt: 'q' });
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.message).toContain('finish_reason=length');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ finishReason: 'length' });
  });

  it('errors with a warn snippet on empty content and no reasoning fields', async () => {
    const warn = jest.fn();
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(completionFixture({ role: 'assistant', content: '' })),
    );
    const result = await makeAdapter(fetchMock, { warn }).complete({ prompt: 'q' });
    expect(result._unsafeUnwrapErr().message).toContain('finish_reason=stop');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toHaveProperty('snippet');
  });

  it('fails a truncated reply that still carries text, naming the ceiling', async () => {
    const warn = jest.fn();
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        completionFixture({ role: 'assistant', content: 'Partial answer that got cut' }, 'length'),
      ),
    );
    const result = await makeAdapter(fetchMock, { warn }).complete({ prompt: 'q' });
    const error = result._unsafeUnwrapErr();
    // A half-written answer carries no quorum weight; the snippet stays in the warn.
    expect(error).toBeInstanceOf(TruncatedPeerAnswerError);
    expect(error.message).toContain('finish_reason=length');
    expect(causeOf(error)).toBe('peer_truncated');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ finishReason: 'length' });
  });

  it('fails a textless answer with the bad-response cause', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(completionFixture({ role: 'assistant', content: '' })),
    );
    const result = await makeAdapter(fetchMock, { warn: jest.fn() }).complete({ prompt: 'q' });
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(EmptyPeerAnswerError);
    expect(error.message).toContain('finish_reason=stop');
    expect(causeOf(error)).toBe('peer_bad_response');
  });

  it('keeps a terse, cleanly finished answer', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(completionFixture({ role: 'assistant', content: 'Yes.' }, 'stop')),
    );
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Yes.');
  });

  it('countTokens estimates ceil(chars/4) and labels the method', async () => {
    const adapter = makeAdapter(jest.fn<typeof fetch>());
    const result = await adapter.countTokens('a'.repeat(10));
    expect(result._unsafeUnwrap()).toEqual({
      totalTokens: 3,
      model: 'model-x',
      method: 'estimate',
    });
  });

  describe('prompt caching', () => {
    it('sends parts byte-identical to the joined string, with no cache field', async () => {
      const bodyFor = async (prompt: Parameters<OpenAiCompatAdapter['complete']>[0]['prompt']): Promise<string> => {
        const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
        await makeAdapter(fetchMock).complete({ prompt, systemInstruction: 's', history: [{ role: 'user', content: 'h' }] });
        return String(fetchMock.mock.calls[0]![1]?.body);
      };
      const fromParts = await bodyFor([{ text: 'head' }, { text: '\n\nD1', reusable: true }, { text: 'tail', reusable: true }]);
      expect(fromParts).toBe(await bodyFor('head\n\nD1tail'));
      expect(fromParts).not.toContain('cache');
    });

    async function usageFor(usage: Record<string, unknown>): Promise<unknown> {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...successFixture, usage }));
      return (await makeAdapter(fetchMock).complete({ prompt: 'q' }))._unsafeUnwrap().usage;
    }

    it('reads prompt_tokens_details.cached_tokens without adding it to the prompt total', async () => {
      expect(
        await usageFor({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 768 } }),
      ).toEqual({ promptTokens: 1000, cachedPromptTokens: 768, completionTokens: 10, totalTokens: 1010 });
    });

    it('reads the DeepSeek-style prompt_cache_hit_tokens', async () => {
      expect(
        await usageFor({ prompt_tokens: 600, completion_tokens: 10, total_tokens: 610, prompt_cache_hit_tokens: 512 }),
      ).toEqual({ promptTokens: 600, cachedPromptTokens: 512, completionTokens: 10, totalTokens: 610 });
    });

    it.each([
      ['no cache field', {}],
      ['an odd details shape', { prompt_tokens_details: 'n/a', prompt_cache_hit_tokens: '5' }],
      ['an odd cached_tokens type', { prompt_tokens_details: { cached_tokens: 'many' } }],
    ])('reports 0 cached tokens with %s', async (_label, extra) => {
      expect(await usageFor({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, ...extra })).toEqual({
        promptTokens: 12,
        cachedPromptTokens: 0,
        completionTokens: 8,
        totalTokens: 20,
      });
    });
  });
});
