import type { PeerReviewQuorumUseCase } from '../../domain/use-cases/index.js';
import type { ArbiterReport } from '../../domain/entities/index.js';
import { PeerReviewInputSchema } from '../schemas/index.js';
import {
  successResponse,
  errorResponse,
  type McpToolResponse,
} from '../../shared/types/index.js';
import { failureFields } from './failure-fields.js';
import type { CallerCeiling } from '../../domain/use-cases/index.js';

export interface PeerReviewResponseData {
  readonly response: string;
  /** Set only on a failed quorum, where the synthesized consensus is withheld and
   * `response` is ''. Key omitted entirely otherwise, so an achieved-quorum
   * envelope stays byte-identical for existing clients. */
  readonly responseWithheld?: true;
  readonly certaintyScore: number;
  /** Present only when the call supplied callerAnswer; null = supplied but unrated. */
  readonly callerAgreement?: number | null;
  readonly quorum: {
    readonly achieved: boolean;
    readonly tier: number;
    readonly requiredWeight: number;
    readonly agreeingWeight: number;
    readonly arbiterFailed?: boolean;
    /** Arbiter failure row on the arbiter-fallback path: {name, status, error}. */
    readonly arbiter?: ArbiterReport;
  };
  readonly tokenUsage: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
}

export class PeerReviewController {
  constructor(
    private readonly useCase: PeerReviewQuorumUseCase,
    /** Present only when the declared caller ceiling no longer clears the deadline. */
    private readonly callerCeiling?: CallerCeiling,
  ) {}

  async handle(
    rawInput: unknown,
    callerSignal?: AbortSignal,
  ): Promise<McpToolResponse<PeerReviewResponseData>> {
    const parsed = PeerReviewInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
      return errorResponse(
        'VALIDATION_ERROR',
        parsed.error.issues.map((issue) => issue.message).join(', '),
        { cause: 'validation', fix: `Correct the ${fields} argument${fields.includes(',') ? 's' : ''} and retry` },
      );
    }

    // Model, temperature, and output limits are injected server-side; the tool
    // input schema is strict so a client cannot smuggle them in.
    const result = await this.useCase.execute(parsed.data, callerSignal);
    if (result.isErr()) {
      // Forward code+message as before, plus the cause, the responsible source,
      // the redacted detail, the fix, and the per-source roster.
      return errorResponse(result.error.code, result.error.message, failureFields(result.error, this.callerCeiling));
    }

    const quorum = result.value;
    return successResponse({
      response: quorum.response,
      ...(quorum.responseWithheld === true ? { responseWithheld: true as const } : {}),
      certaintyScore: quorum.certaintyScore,
      // Key omitted (not null) when no callerAnswer was supplied — the envelope
      // stays byte-identical for existing clients.
      ...(quorum.callerAgreement !== undefined
        ? { callerAgreement: quorum.callerAgreement }
        : {}),
      quorum: {
        achieved: quorum.achieved,
        tier: quorum.tier,
        requiredWeight: quorum.requiredWeight,
        agreeingWeight: quorum.agreeingWeight,
        ...(quorum.arbiterFailed === true ? { arbiterFailed: true } : {}),
        ...(quorum.arbiter !== undefined ? { arbiter: quorum.arbiter } : {}),
        sources: quorum.sources,
      },
      tokenUsage: {
        prompt: quorum.usage.promptTokens,
        completion: quorum.usage.completionTokens,
        total: quorum.usage.totalTokens,
      },
    });
  }
}
