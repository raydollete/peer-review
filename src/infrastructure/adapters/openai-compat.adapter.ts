import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import type { IPeerClient } from '../../domain/ports/index.js';
import { promptText, type PeerRequest, type PeerResponse, type TokenCountResult } from '../../domain/entities/index.js';
import { ExternalServiceError, type DomainError } from '../../shared/errors/index.js';
import { EmptyPeerAnswerError, TruncatedPeerAnswerError } from '../../domain/errors/index.js';
import type { ILogger } from '../../shared/logger/index.js';
import { sanitizeModelText } from '../../shared/text/index.js';
import type { ICredentialProvider } from './credential-provider.js';
import { postJson, type HttpDeps } from './http.js';

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        // Reasoning endpoints may omit `content` entirely or park text in
        // `reasoning_content`/`reasoning`; some gateways send `reasoning` as an
        // object, which degrades to absent rather than failing the response.
        message: z.object({
          content: z.string().nullish(),
          reasoning_content: z.string().nullish().catch(undefined),
          reasoning: z.string().nullish().catch(undefined),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
      // Cached tokens are already inside prompt_tokens. OpenAI-style gateways
      // report them under prompt_tokens_details, DeepSeek as
      // prompt_cache_hit_tokens; an odd shape degrades to absent (0).
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().nullish().catch(undefined) })
        .nullish()
        .catch(undefined),
      prompt_cache_hit_tokens: z.number().nullish().catch(undefined),
    })
    .optional(),
});

type CompletionMessage = z.infer<typeof CompletionSchema>['choices'][number]['message'];

export interface OpenAiCompatAdapterConfig {
  readonly sourceName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly credentialProvider: ICredentialProvider;
  readonly logger?: Pick<ILogger, 'warn'>;
  /** Opt-in structured-output request; only honoured when the request
   * carries the `responseFormat: 'json'` hint. */
  readonly jsonMode?: boolean;
}

type WireMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class OpenAiCompatAdapter implements IPeerClient {
  constructor(
    private readonly cfg: OpenAiCompatAdapterConfig,
    private readonly deps: HttpDeps = {},
  ) {}

  async complete(request: PeerRequest): Promise<Result<PeerResponse, DomainError>> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.buildMessages(request),
      max_tokens: this.cfg.maxOutputTokens,
    };
    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }
    if (this.cfg.jsonMode === true && request.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }

    const result = await postJson(
      {
        url: `${this.cfg.baseUrl}/chat/completions`,
        body,
        headers: (credential) => ({ authorization: `Bearer ${credential}` }),
        credentialProvider: this.cfg.credentialProvider,
        serviceName: this.cfg.sourceName,
        timeoutMs: this.cfg.timeoutMs,
        signal: request.signal,
      },
      this.deps,
    );
    if (result.isErr()) {
      return err(result.error);
    }
    return this.normalize(result.value);
  }

  async countTokens(text: string): Promise<Result<TokenCountResult, DomainError>> {
    // No standard token-count endpoint in the chat-completions wire format.
    return ok({
      totalTokens: Math.ceil(text.length / 4),
      model: this.cfg.model,
      method: 'estimate',
    });
  }

  private buildMessages(request: PeerRequest): WireMessage[] {
    const messages: WireMessage[] = [];
    if (request.systemInstruction !== undefined) {
      messages.push({ role: 'system', content: request.systemInstruction });
    }
    for (const turn of request.history ?? []) {
      messages.push({
        role: turn.role === 'model' ? 'assistant' : 'user',
        content: turn.content,
      });
    }
    messages.push({ role: 'user', content: promptText(request.prompt) });
    return messages;
  }

  private normalize(raw: unknown): Result<PeerResponse, DomainError> {
    const parsed = CompletionSchema.safeParse(raw);
    if (!parsed.success) {
      return err(
        new ExternalServiceError('Malformed chat-completion response', this.cfg.sourceName),
      );
    }
    const choice = parsed.data.choices[0];
    if (choice === undefined) {
      return err(
        new ExternalServiceError('Chat-completion response has no choices', this.cfg.sourceName),
      );
    }
    const usage = parsed.data.usage;
    const finishReason = choice.finish_reason ?? 'unknown';
    const completionTokens = usage?.completion_tokens ?? 0;
    const extracted = this.extractText(choice.message, finishReason, completionTokens);
    if (finishReason === 'length') {
      // The provider stopped the reply at its own output ceiling: a half-written
      // answer carries no quorum weight, with or without text. The warn fires
      // once — extractText already warned when there was no text to show.
      if (extracted.isOk()) {
        this.cfg.logger?.warn('Peer response truncated at max_tokens', {
          source: this.cfg.sourceName,
          finishReason,
          snippet: extracted.value.slice(0, 300),
        });
      }
      return err(
        new TruncatedPeerAnswerError(
          `Peer stopped at max_tokens (finish_reason=${finishReason}, completion=${completionTokens})`,
          this.cfg.sourceName,
          finishReason,
          completionTokens,
        ),
      );
    }
    if (extracted.isErr()) {
      return err(extracted.error);
    }
    return ok({
      text: extracted.value,
      model: this.cfg.model,
      source: this.cfg.sourceName,
      finishReason,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        cachedPromptTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    });
  }

  /** Answer text lives in `content`; fall back to the reasoning fields only
   * when content is empty (gateways that never populate `content`). */
  private extractText(
    message: CompletionMessage,
    finishReason: string,
    completionTokens: number,
  ): Result<string, DomainError> {
    let text = sanitizeModelText(message.content ?? '');
    if (text === '') {
      text = sanitizeModelText(message.reasoning_content ?? message.reasoning ?? '');
    }
    if (text !== '') {
      return ok(text);
    }
    this.cfg.logger?.warn('Peer returned empty text after sanitization', {
      source: this.cfg.sourceName,
      finishReason,
      snippet: (message.content ?? message.reasoning_content ?? '').slice(0, 300),
    });
    return err(
      new EmptyPeerAnswerError(
        `Peer returned no usable text (finish_reason=${finishReason}, completion=${completionTokens})`,
        this.cfg.sourceName,
        finishReason,
        completionTokens,
      ),
    );
  }
}
