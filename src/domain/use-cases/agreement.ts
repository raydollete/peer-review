import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import type { PeerResponse, TokenUsage } from '../entities/index.js';
import type { IPeerClient } from '../ports/index.js';
import { ArbiterMalformedError, type DomainError } from '../errors/index.js';
import type { ILogger } from '../../shared/logger/index.js';
import { sanitizeModelText, stripCodeFences } from '../../shared/text/index.js';
import {
  ARBITER_SYSTEM_PROMPT,
  callerRulesSuffix,
  CALLER_SOURCE_NAME,
  buildArbiterPrompt,
  documentId,
  missingRatingsSuffix,
  REASK_SUFFIX,
} from './agreement-prompt.js';

/** A source agrees with the consensus when its rating meets this threshold. */
export const AGREEMENT_THRESHOLD = 0.7;

/** Longest arbiter reason kept on a roster row. */
export const REASON_MAX_CHARS = 300;

const EvaluationSchema = z.object({
  // Rejects a blank consensus without rewriting the prose the caller receives.
  consensus: z.string().refine((consensus) => consensus.trim() !== ''),
  ratings: z.array(
    z.object({
      id: z.string(),
      reason: z.string().optional(),
      agreement: z.number().min(0).max(1),
    }),
  ),
});

type ParsedRating = z.infer<typeof EvaluationSchema>['ratings'][number];

export interface AgreementRating {
  readonly name: string;
  readonly agreement: number;
  /** The arbiter's one-line explanation of the score; absent when it gave none. */
  readonly reason?: string;
}

export interface AgreementEvaluation {
  readonly consensus: string;
  /** Peer ratings only — the caller's rating is split out and never appears here. */
  readonly ratings: readonly AgreementRating[];
  /** Set only when a callerAnswer was supplied; null = the arbiter omitted the rating. */
  readonly callerAgreement?: number | null;
  readonly usage: TokenUsage;
}

export interface EvaluateAgreementParams {
  readonly arbiter: { readonly name: string; readonly client: IPeerClient };
  readonly question: string;
  readonly responses: readonly PeerResponse[];
  /** The calling agent's own answer — rated by the arbiter, never sent to peers. */
  readonly callerAnswer?: string | undefined;
  /** The run's fence token: minted once per run, shared by every arbiter request
   * in it (re-ask and escalations), never sent to a peer. */
  readonly fenceTag: string;
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

/** One line, at most REASON_MAX_CHARS: the reason is model output shown to the
 * caller, so it is bounded here at the boundary. Empty → absent. */
function oneLineReason(reason: string | undefined): string | undefined {
  const line = reason?.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX_CHARS).trim();
  return line === undefined || line === '' ? undefined : line;
}

/** The ids the arbiter must rate: one per peer document, plus `caller` when a
 * caller answer was supplied. */
function expectedIds(params: EvaluateAgreementParams): string[] {
  const ids = params.responses.map((_, index) => documentId(index));
  return params.callerAnswer === undefined ? ids : [...ids, CALLER_SOURCE_NAME];
}

/**
 * Map the arbiter's `D<n>` ids back to source names. An id that names no
 * document is dropped and a repeated id keeps its first rating, each with a
 * warning — so no rating that matches no peer can reach the weight sum or the
 * certainty mean. The reserved `caller` id passes through under its own name.
 */
function mapRatings(parsed: readonly ParsedRating[], params: EvaluateAgreementParams): AgreementRating[] {
  const sourceById = new Map(params.responses.map((response, index) => [documentId(index), response.source]));
  sourceById.set(CALLER_SOURCE_NAME, CALLER_SOURCE_NAME);
  const seen = new Set<string>();
  const ratings: AgreementRating[] = [];
  for (const rating of parsed) {
    const name = sourceById.get(rating.id);
    if (name === undefined || seen.has(rating.id)) {
      params.logger?.warn(
        name === undefined ? 'Arbiter rated an unknown document id' : 'Arbiter rated a document twice',
        { arbiter: params.arbiter.name, id: rating.id },
      );
      continue;
    }
    seen.add(rating.id);
    const reason = oneLineReason(rating.reason);
    ratings.push({ name, agreement: rating.agreement, ...(reason !== undefined ? { reason } : {}) });
  }
  return ratings;
}

/** Expected ids the reply left without a rating, logged when any are missing. */
function unratedIds(parsed: readonly ParsedRating[], params: EvaluateAgreementParams): string[] {
  const rated = new Set(parsed.map((r) => r.id));
  const missing = expectedIds(params).filter((id) => !rated.has(id));
  if (missing.length > 0) {
    params.logger?.warn('Arbiter reply left documents unrated', { arbiter: params.arbiter.name, missing });
  }
  return missing;
}

function toEvaluation(
  data: z.infer<typeof EvaluationSchema>,
  params: EvaluateAgreementParams,
  usage: TokenUsage,
): AgreementEvaluation {
  const { peerRatings, callerAgreement } = splitCallerRating(mapRatings(data.ratings, params), params);
  return {
    consensus: data.consensus,
    ratings: peerRatings,
    ...(callerAgreement !== undefined ? { callerAgreement } : {}),
    usage,
  };
}

/**
 * Split the caller's rating out of the peer ratings so no downstream consumer
 * (quorum weight, sources[]) ever sees a phantom "caller" peer. With no
 * callerAnswer supplied, a hallucinated caller entry is dropped.
 */
function splitCallerRating(
  ratings: readonly AgreementRating[],
  params: EvaluateAgreementParams,
): { peerRatings: readonly AgreementRating[]; callerAgreement?: number | null } {
  const peerRatings = ratings.filter((r) => r.name !== CALLER_SOURCE_NAME);
  if (params.callerAnswer === undefined) {
    return { peerRatings };
  }
  const callerRating = ratings.find((r) => r.name === CALLER_SOURCE_NAME);
  if (callerRating === undefined) {
    params.logger?.warn('Arbiter omitted the caller rating', {
      arbiter: params.arbiter.name,
    });
  }
  return { peerRatings, callerAgreement: callerRating?.agreement ?? null };
}

function warnMalformed(params: EvaluateAgreementParams, attempt: number, reply: PeerResponse): void {
  params.logger?.warn('Arbiter reply failed JSON extraction', {
    arbiter: params.arbiter.name,
    attempt,
    finishReason: reply.finishReason,
    snippet: reply.text.slice(0, 300),
  });
}

/**
 * Ask the arbiter (temperature 0) to rate each peer response against its own
 * consensus answer. Peer responses are passed as delimited data under `D<n>` ids,
 * never as instructions. One re-ask, on malformed JSON or on a reply that leaves
 * an expected id unrated; whatever is still unrated after it stays unrated, and a
 * re-ask that fails without an abort keeps the first reply. Other transport
 * errors fail immediately.
 */
export async function evaluateAgreement(
  params: EvaluateAgreementParams,
): Promise<Result<AgreementEvaluation, DomainError>> {
  const usage = { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let reask = REASK_SUFFIX;
  // A valid reply that left ids unrated: the re-ask may only improve on it, so a
  // failed re-ask falls back to it rather than failing the whole evaluation.
  let incomplete: z.infer<typeof EvaluationSchema> | undefined;

  // One prompt per evaluation, built from the run's fence token; the re-ask
  // repeats it unchanged and appends its correction as a separate part.
  const prompt = buildArbiterPrompt(
    params.question,
    params.responses.map((response) => response.text),
    params.callerAnswer,
    params.fenceTag,
  );
  const systemInstruction =
    ARBITER_SYSTEM_PROMPT + (params.callerAnswer === undefined ? '' : callerRulesSuffix(params.fenceTag));

  for (const attempt of [0, 1]) {
    const result = await params.arbiter.client.complete({
      prompt: attempt === 0 ? prompt : [...prompt, { text: reask }],
      systemInstruction,
      temperature: 0,
      signal: params.signal,
      responseFormat: 'json',
    });
    if (result.isErr()) {
      return incomplete !== undefined && params.signal?.aborted !== true
        ? ok(toEvaluation(incomplete, params, usage))
        : err(result.error);
    }
    usage.promptTokens += result.value.usage.promptTokens;
    usage.cachedPromptTokens += result.value.usage.cachedPromptTokens;
    usage.completionTokens += result.value.usage.completionTokens;
    usage.totalTokens += result.value.usage.totalTokens;

    const parsed = EvaluationSchema.safeParse(extractJson(result.value.text));
    if (parsed.success) {
      const missing = unratedIds(parsed.data.ratings, params);
      if (missing.length > 0 && attempt === 0) {
        incomplete = parsed.data;
        reask = missingRatingsSuffix(missing);
        continue;
      }
      return ok(toEvaluation(parsed.data, params, usage));
    }
    warnMalformed(params, attempt, result.value);
  }

  if (incomplete !== undefined) {
    return ok(toEvaluation(incomplete, params, usage));
  }
  const detail = 'Arbiter returned malformed JSON after one re-ask';
  return err(new ArbiterMalformedError(detail, params.arbiter.name));
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
