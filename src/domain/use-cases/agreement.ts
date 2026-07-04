import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import type { PeerResponse, TokenUsage } from '../entities/index.js';
import type { IPeerClient } from '../ports/index.js';
import { ExternalServiceError, type DomainError } from '../errors/index.js';
import { ARBITER_SYSTEM_PROMPT, buildArbiterPrompt, REASK_SUFFIX } from './agreement-prompt.js';

/** A source agrees with the consensus when its rating meets this threshold. */
export const AGREEMENT_THRESHOLD = 0.7;

const EvaluationSchema = z.object({
  consensus: z.string(),
  ratings: z.array(z.object({ name: z.string(), agreement: z.number().min(0).max(1) })),
});

export interface AgreementRating {
  readonly name: string;
  readonly agreement: number;
}

export interface AgreementEvaluation {
  readonly consensus: string;
  readonly ratings: readonly AgreementRating[];
  readonly usage: TokenUsage;
}

export interface EvaluateAgreementParams {
  readonly arbiter: { readonly name: string; readonly client: IPeerClient };
  readonly question: string;
  readonly responses: readonly PeerResponse[];
  readonly signal?: AbortSignal | undefined;
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Ask the arbiter (temperature 0) to rate each peer response against its own
 * consensus answer. Peer responses are passed as delimited data, never as
 * instructions. One re-ask on malformed JSON; transport errors fail immediately.
 */
export async function evaluateAgreement(
  params: EvaluateAgreementParams,
): Promise<Result<AgreementEvaluation, DomainError>> {
  const basePrompt = buildArbiterPrompt(
    params.question,
    params.responses.map((response) => ({ source: response.source, text: response.text })),
  );
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (const attempt of [0, 1]) {
    const result = await params.arbiter.client.complete({
      prompt: attempt === 0 ? basePrompt : basePrompt + REASK_SUFFIX,
      systemInstruction: ARBITER_SYSTEM_PROMPT,
      temperature: 0,
      signal: params.signal,
    });
    if (result.isErr()) {
      return err(result.error);
    }
    usage.promptTokens += result.value.usage.promptTokens;
    usage.completionTokens += result.value.usage.completionTokens;
    usage.totalTokens += result.value.usage.totalTokens;

    const parsed = EvaluationSchema.safeParse(extractJson(result.value.text));
    if (parsed.success) {
      return ok({ consensus: parsed.data.consensus, ratings: parsed.data.ratings, usage });
    }
  }

  return err(
    new ExternalServiceError('Arbiter returned malformed JSON after one re-ask', params.arbiter.name),
  );
}

/** `min(1, agreeingWeight / requiredWeight) × mean agreement of agreeing sources`, in [0, 1]. */
export function computeCertainty(
  agreeingWeight: number,
  requiredWeight: number,
  agreeingRatings: readonly number[],
): number {
  if (requiredWeight <= 0 || agreeingRatings.length === 0) {
    return 0;
  }
  const mean = agreeingRatings.reduce((sum, rating) => sum + rating, 0) / agreeingRatings.length;
  return Math.min(1, agreeingWeight / requiredWeight) * mean;
}
