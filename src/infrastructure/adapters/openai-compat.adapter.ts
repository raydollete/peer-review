import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import type { IPeerClient } from '../../domain/ports/index.js';
import type { PeerRequest, PeerResponse, TokenCountResult } from '../../domain/entities/index.js';
import { ExternalServiceError, type DomainError } from '../../shared/errors/index.js';
import type { ICredentialProvider } from './credential-provider.js';
import { postJson, type HttpDeps } from './http.js';

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
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

export interface OpenAiCompatAdapterConfig {
  readonly sourceName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly credentialProvider: ICredentialProvider;
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
    return ok({
      text: choice.message.content ?? '',
      model: this.cfg.model,
      source: this.cfg.sourceName,
      finishReason: choice.finish_reason ?? 'unknown',
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    });
  }
}
