import { jest } from '@jest/globals';
import { OpenAiCompatAdapter } from '../openai-compat.adapter.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import { PeerApiError, PeerRateLimitError } from '../../../domain/errors/index.js';
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

function makeAdapter(fetchFn: typeof fetch): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter(
    {
      sourceName: 'gpt-large',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-x',
      timeoutMs: 5000,
      maxOutputTokens: 1024,
      credentialProvider: new StubCredentialProvider('sk-test'),
    },
    instantDeps(fetchFn),
  );
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
    expect(response.usage).toEqual({ promptTokens: 12, completionTokens: 8, totalTokens: 20 });

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

  it('countTokens estimates ceil(chars/4) and labels the method', async () => {
    const adapter = makeAdapter(jest.fn<typeof fetch>());
    const result = await adapter.countTokens('a'.repeat(10));
    expect(result._unsafeUnwrap()).toEqual({
      totalTokens: 3,
      model: 'model-x',
      method: 'estimate',
    });
  });
});
