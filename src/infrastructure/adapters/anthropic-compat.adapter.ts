import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import type { IPeerClient } from '../../domain/ports/index.js';
import type { PeerRequest, PeerResponse, TokenCountResult } from '../../domain/entities/index.js';
import { ExternalServiceError, type DomainError } from '../../shared/errors/index.js';
import { EmptyPeerAnswerError, TruncatedPeerAnswerError } from '../../domain/errors/index.js';
import type { ILogger } from '../../shared/logger/index.js';
import { sanitizeModelText } from '../../shared/text/index.js';
import type { ICredentialProvider } from './credential-provider.js';
import { postJson, type HttpDeps } from './http.js';

const ANTHROPIC_VERSION = '2023-06-01';

const MessageResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullish(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      // Cache fields are optional; an odd shape degrades to absent (0).
      cache_read_input_tokens: z.number().nullish().catch(undefined),
      cache_creation_input_tokens: z.number().nullish().catch(undefined),
    })
    .optional(),
});

const CountTokensResponseSchema = z.object({ input_tokens: z.number() });

export interface AnthropicCompatAdapterConfig {
  readonly sourceName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly credentialProvider: ICredentialProvider;
  readonly logger?: Pick<ILogger, 'warn'>;
}

type TextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
type WireMessage = { role: 'user' | 'assistant'; content: string | TextBlock[] };

const EPHEMERAL = { type: 'ephemeral' } as const;

export class AnthropicCompatAdapter implements IPeerClient {
  constructor(
    private readonly cfg: AnthropicCompatAdapterConfig,
    private readonly deps: HttpDeps = {},
  ) {}

  async complete(request: PeerRequest): Promise<Result<PeerResponse, DomainError>> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxOutputTokens,
      messages: this.buildMessages(request),
    };
    if (request.systemInstruction !== undefined) {
      body['system'] = request.systemInstruction;
    }
    // `request.temperature` is deliberately not forwarded: current Anthropic models
    // reject it with HTTP 400 ("`temperature` is deprecated for this model."), which
    // broke every review whose arbiter is a Claude model.

    const result = await this.post('/v1/messages', body, request.signal);
    if (result.isErr()) {
      return err(result.error);
    }
    return this.normalize(result.value);
  }

  async countTokens(text: string): Promise<Result<TokenCountResult, DomainError>> {
    const body = {
      model: this.cfg.model,
      messages: [{ role: 'user', content: text }],
    };
    const result = await this.post('/v1/messages/count_tokens', body, undefined);
    if (result.isErr()) {
      return err(result.error);
    }
    const parsed = CountTokensResponseSchema.safeParse(result.value);
    if (!parsed.success) {
      return err(
        new ExternalServiceError('Malformed count-tokens response', this.cfg.sourceName),
      );
    }
    return ok({
      totalTokens: parsed.data.input_tokens,
      model: this.cfg.model,
      method: 'api',
    });
  }

  private post(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Result<unknown, DomainError>> {
    return postJson(
      {
        url: `${this.cfg.baseUrl}${path}`,
        body,
        headers: (credential) => ({
          'x-api-key': credential,
          'anthropic-version': ANTHROPIC_VERSION,
        }),
        credentialProvider: this.cfg.credentialProvider,
        serviceName: this.cfg.sourceName,
        timeoutMs: this.cfg.timeoutMs,
        signal,
      },
      this.deps,
    );
  }

  private buildMessages(request: PeerRequest): WireMessage[] {
    const messages: WireMessage[] = [];
    for (const turn of request.history ?? []) {
      messages.push({
        role: turn.role === 'model' ? 'assistant' : 'user',
        content: turn.content,
      });
    }
    messages.push({ role: 'user', content: this.finalContent(request) });
    return messages;
  }

  /** The final user message. A one-shot string prompt stays a plain string (no
   * cache write for a prompt never repeated); parts become one text block each,
   * with a cache breakpoint on each reusable part; a string prompt after history
   * is one marked block, so the next turn reads the conversation from cache. */
  private finalContent(request: PeerRequest): string | TextBlock[] {
    if (typeof request.prompt !== 'string') {
      return request.prompt.map((part) =>
        part.reusable === true
          ? { type: 'text', text: part.text, cache_control: EPHEMERAL }
          : { type: 'text', text: part.text },
      );
    }
    if ((request.history ?? []).length === 0) {
      return request.prompt;
    }
    return [{ type: 'text', text: request.prompt, cache_control: EPHEMERAL }];
  }

  private normalize(raw: unknown): Result<PeerResponse, DomainError> {
    const parsed = MessageResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return err(new ExternalServiceError('Malformed messages response', this.cfg.sourceName));
    }
    const text = parsed.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const finishReason = parsed.data.stop_reason ?? 'unknown';
    const usage = parsed.data.usage;
    // `input_tokens` counts only the uncached tail; the full prompt adds what
    // the cache served and what it wrote.
    const cachedTokens = usage?.cache_read_input_tokens ?? 0;
    const inputTokens =
      (usage?.input_tokens ?? 0) + cachedTokens + (usage?.cache_creation_input_tokens ?? 0);
    const outputTokens = usage?.output_tokens ?? 0;
    const unusable = this.unusableAnswer(text, finishReason, outputTokens);
    if (unusable !== undefined) {
      return err(unusable);
    }
    return ok({
      text,
      model: this.cfg.model,
      source: this.cfg.sourceName,
      finishReason,
      usage: {
        promptTokens: inputTokens,
        cachedPromptTokens: cachedTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    });
  }

  /** A reply that cannot carry a vote: stopped at the output ceiling, or no answer
   * text at all. The stop signal is checked first because hidden reasoning is
   * billed against max_tokens and that repair is the source's output budget.
   * Text is sanitized only to decide emptiness; the reply itself is returned as-is. */
  private unusableAnswer(
    text: string,
    finishReason: string,
    completionTokens: number,
  ): DomainError | undefined {
    if (finishReason === 'max_tokens') {
      this.cfg.logger?.warn('Peer response truncated at max_tokens', {
        source: this.cfg.sourceName,
        finishReason,
        snippet: text.slice(0, 300),
      });
      return new TruncatedPeerAnswerError(
        `Peer stopped at max_tokens (stop_reason=${finishReason}, completion=${completionTokens})`,
        this.cfg.sourceName,
        finishReason,
        completionTokens,
      );
    }
    if (sanitizeModelText(text) === '') {
      this.cfg.logger?.warn('Peer returned empty text after sanitization', {
        source: this.cfg.sourceName,
        finishReason,
        snippet: text.slice(0, 300),
      });
      return new EmptyPeerAnswerError(
        `Peer returned no usable text (stop_reason=${finishReason}, completion=${completionTokens})`,
        this.cfg.sourceName,
        finishReason,
        completionTokens,
      );
    }
    return undefined;
  }
}
