import { jest } from '@jest/globals';
import { AnthropicCompatAdapter } from '../anthropic-compat.adapter.js';
import { PeerRateLimitError } from '../../../domain/errors/index.js';
import { StubCredentialProvider, jsonResponse, instantDeps } from './test-helpers.js';

const successFixture = {
  id: 'msg_123',
  type: 'message',
  content: [{ type: 'text', text: 'Paris.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 15, output_tokens: 5 },
};

function makeAdapter(fetchFn: typeof fetch): AnthropicCompatAdapter {
  return new AnthropicCompatAdapter(
    {
      sourceName: 'claude',
      baseUrl: 'https://api.example.com',
      model: 'model-y',
      timeoutMs: 5000,
      maxOutputTokens: 2048,
      credentialProvider: new StubCredentialProvider('ak-test'),
    },
    instantDeps(fetchFn),
  );
}

describe('AnthropicCompatAdapter', () => {
  it('posts to /v1/messages with x-api-key + anthropic-version and normalizes', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
    const adapter = makeAdapter(fetchMock);

    const result = await adapter.complete({
      prompt: 'Capital of France?',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'model', content: 'hello' },
      ],
      systemInstruction: 'be terse',
      temperature: 0,
    });

    const response = result._unsafeUnwrap();
    expect(response.text).toBe('Paris.');
    expect(response.finishReason).toBe('end_turn');
    expect(response.usage).toEqual({ promptTokens: 15, completionTokens: 5, totalTokens: 20 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/messages');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ak-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body));
    expect(body.system).toBe('be terse');
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'Capital of France?' },
    ]);
  });

  it('retries 429 twice then returns PeerRateLimitError', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ type: 'error' }, 429));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(PeerRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('countTokens calls /v1/messages/count_tokens and labels method api', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ input_tokens: 42 }));
    const result = await makeAdapter(fetchMock).countTokens('some text');
    expect(result._unsafeUnwrap()).toEqual({ totalTokens: 42, model: 'model-y', method: 'api' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/messages/count_tokens');
    const body = JSON.parse(String(init?.body));
    expect(body.messages).toEqual([{ role: 'user', content: 'some text' }]);
  });

  it('joins multiple text blocks in order', async () => {
    const fixture = {
      ...successFixture,
      content: [
        { type: 'text', text: 'Part one. ' },
        { type: 'tool_use', id: 'x' },
        { type: 'text', text: 'Part two.' },
      ],
    };
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Part one. Part two.');
  });
});
