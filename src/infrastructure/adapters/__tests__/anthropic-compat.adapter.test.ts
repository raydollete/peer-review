import { jest } from '@jest/globals';
import { AnthropicCompatAdapter } from '../anthropic-compat.adapter.js';
import { causeOf, PeerRateLimitError, TruncatedPeerAnswerError, EmptyPeerAnswerError } from '../../../domain/errors/index.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import { StubCredentialProvider, jsonResponse, instantDeps } from './test-helpers.js';

const successFixture = {
  id: 'msg_123',
  type: 'message',
  content: [{ type: 'text', text: 'Paris.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 15, output_tokens: 5 },
};

function makeAdapter(
  fetchFn: typeof fetch,
  logger?: { warn: (message: string, context?: Record<string, unknown>) => void },
): AnthropicCompatAdapter {
  return new AnthropicCompatAdapter(
    {
      sourceName: 'claude',
      baseUrl: 'https://api.example.com',
      model: 'model-y',
      timeoutMs: 5000,
      maxOutputTokens: 2048,
      credentialProvider: new StubCredentialProvider('ak-test'),
      ...(logger !== undefined ? { logger } : {}),
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
    expect(response.usage).toEqual({ promptTokens: 15, cachedPromptTokens: 0, completionTokens: 5, totalTokens: 20 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/messages');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ak-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body));
    expect(body.system).toBe('be terse');
    expect(body.max_tokens).toBe(2048);
    // Current Anthropic models reject `temperature` with HTTP 400 ("`temperature` is
    // deprecated for this model."), so the adapter never forwards it.
    expect(body).not.toHaveProperty('temperature');
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'Capital of France?', cache_control: { type: 'ephemeral' } }] },
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

  it('rejects an empty reply and names the stop_reason', async () => {
    const fixture = { ...successFixture, content: [], stop_reason: 'max_tokens' };
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    const error = result._unsafeUnwrapErr();
    // A reply with no text inside the ceiling is the truncation shape: the repair
    // is the source's output budget, so it names the cause that says so.
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.message).toContain('stop_reason=max_tokens');
    expect(causeOf(error)).toBe('peer_truncated');
  });

  it('fails the thinking-only max_tokens body a reasoning model returns', async () => {
    // Shape captured live 2026-11-16 from POST /v1/messages at max_tokens 8192:
    // content held only a thinking block and the whole budget was billed to it.
    const fixture = {
      ...successFixture,
      content: [{ type: 'thinking', thinking: 'deliberating over every requirement…' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1450, output_tokens: 8192 },
    };
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'review this change' });
    const error = result._unsafeUnwrapErr();
    // An empty answer must never reach the quorum as an ok vote with agreement 0.
    expect(error).toBeInstanceOf(TruncatedPeerAnswerError);
    expect(error.message).toContain('stop_reason=max_tokens');
    expect(error.message).toContain('completion=8192');
    expect(causeOf(error)).toBe('peer_truncated');
  });

  it('fails a refusal with no output', async () => {
    const fixture = {
      ...successFixture,
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 1450, output_tokens: 0 },
    };
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(EmptyPeerAnswerError);
    expect(error.message).toContain('stop_reason=refusal');
    expect(causeOf(error)).toBe('peer_bad_response');
  });

  it('accepts a terse answer that finished cleanly', async () => {
    const fixture = {
      ...successFixture,
      content: [{ type: 'text', text: 'Yes.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture));
    const result = await makeAdapter(fetchMock).complete({ prompt: 'q' });
    expect(result._unsafeUnwrap().text).toBe('Yes.');
  });

  it('fails a truncated answer that did emit text and warns once', async () => {
    const fixture = {
      ...successFixture,
      content: [{ type: 'text', text: 'Partial answer' }],
      stop_reason: 'max_tokens',
    };
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture));
    const warn = jest.fn();
    const result = await makeAdapter(fetchMock, { warn }).complete({ prompt: 'q' });
    const error = result._unsafeUnwrapErr();
    // A half-written answer carries no quorum weight; the snippet stays in the warn.
    expect(error).toBeInstanceOf(TruncatedPeerAnswerError);
    expect(causeOf(error)).toBe('peer_truncated');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Peer response truncated at max_tokens', {
      source: 'claude',
      finishReason: 'max_tokens',
      snippet: 'Partial answer',
    });
  });

  describe('prompt caching', () => {
    async function sentBody(request: Parameters<AnthropicCompatAdapter['complete']>[0]): Promise<Record<string, unknown>> {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(successFixture));
      await makeAdapter(fetchMock).complete(request);
      return JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    }

    it('sends a one-shot string prompt unchanged, with no cache_control', async () => {
      const raw = JSON.stringify(await sentBody({ prompt: 'q', systemInstruction: 's' }));
      expect(raw).toBe(
        JSON.stringify({ model: 'model-y', max_tokens: 2048, messages: [{ role: 'user', content: 'q' }], system: 's' }),
      );
      expect(raw).not.toContain('cache_control');
    });

    it('sends parts as text blocks with breakpoints on exactly the reusable ones', async () => {
      const body = await sentBody({
        prompt: [{ text: 'a' }, { text: 'b', reusable: true }, { text: 'c' }, { text: 'd', reusable: true }],
      });
      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'c' },
            { type: 'text', text: 'd', cache_control: { type: 'ephemeral' } },
          ],
        },
      ]);
    });

    it('marks the final user message of a conversation so the next turn reads its prefix', async () => {
      const body = await sentBody({
        prompt: 'next',
        history: [
          { role: 'user', content: 'first' },
          { role: 'model', content: 'reply' },
        ],
      });
      expect(body['messages']).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: [{ type: 'text', text: 'next', cache_control: { type: 'ephemeral' } }] },
      ]);
    });

    it('counts cache reads and writes in the prompt total', async () => {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ...successFixture,
          usage: { input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60, output_tokens: 20 },
        }),
      );
      const response = (await makeAdapter(fetchMock).complete({ prompt: 'q' }))._unsafeUnwrap();
      expect(response.usage).toEqual({ promptTokens: 1000, cachedPromptTokens: 900, completionTokens: 20, totalTokens: 1020 });
    });

    it('reads an odd-shaped cache field as 0 instead of failing the response', async () => {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ...successFixture,
          usage: { input_tokens: 15, cache_read_input_tokens: 'x', cache_creation_input_tokens: { n: 1 }, output_tokens: 5 },
        }),
      );
      const response = (await makeAdapter(fetchMock).complete({ prompt: 'q' }))._unsafeUnwrap();
      expect(response.usage).toEqual({ promptTokens: 15, cachedPromptTokens: 0, completionTokens: 5, totalTokens: 20 });
    });
  });
});
