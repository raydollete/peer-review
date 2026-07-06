import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import type { IPeerClient } from '../../domain/ports/index.js';
import type { PeerRequest, PeerResponse, TokenCountResult } from '../../domain/entities/index.js';
import { ExternalServiceError, type DomainError } from '../../shared/errors/index.js';
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
    messages.push({ role: 'user', content: request.prompt });
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
    const text = this.extractText(choice.message, finishReason);
    if (text.isErr()) {
      return err(text.error);
    }
    if (finishReason === 'length') {
      this.cfg.logger?.warn('Peer response truncated at max_tokens', {
        source: this.cfg.sourceName,
        finishReason,
        snippet: text.value.slice(0, 300),
      });
    }
    return ok({
      text: text.value,
      model: this.cfg.model,
      source: this.cfg.sourceName,
      finishReason,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
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
      new ExternalServiceError(
        `Peer returned no usable text (finish_reason=${finishReason})`,
        this.cfg.sourceName,
      ),
    );
  }
}
