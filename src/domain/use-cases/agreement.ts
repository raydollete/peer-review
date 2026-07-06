import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import type { PeerResponse, TokenUsage } from '../entities/index.js';
import type { IPeerClient } from '../ports/index.js';
import { ExternalServiceError, type DomainError } from '../errors/index.js';
import type { ILogger } from '../../shared/logger/index.js';
import { sanitizeModelText, stripCodeFences } from '../../shared/text/index.js';
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
  readonly logger?: Pick<ILogger, 'warn'> | undefined;
}

/** Balanced top-level `{…}` spans, tracked across JSON string/escape state so
 * braces inside string values don't split a candidate. */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

/**
 * Reasoning models may leak thinking, prose, or JSON-shaped drafts around the
 * verdict; the final answer comes last, so candidates are tried last-first.
 */
export function extractJson(text: string): unknown {
  const cleaned = stripCodeFences(sanitizeModelText(text));
  const candidates = jsonCandidates(cleaned);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]!) as unknown;
    } catch {
      // Not valid JSON — try the previous candidate.
    }
  }
  return undefined;
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
    params.logger?.warn('Arbiter reply failed JSON extraction', {
      arbiter: params.arbiter.name,
      attempt,
      finishReason: result.value.finishReason,
      snippet: result.value.text.slice(0, 300),
    });
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
